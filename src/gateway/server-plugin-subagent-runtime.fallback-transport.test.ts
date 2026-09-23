import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import { createColdPluginHermeticEnv } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";

const PLUGIN_ID = "test-completion";
const PINNED_KEY = "sk-pinned-account";
const OTHER_KEY = "sk-other-account";
const BASE_URL = "http://127.0.0.1:9/v1";

type RecordedHit = {
  url: string;
  authorization: string | null;
};

function providerModel(id: string) {
  return makeProviderModelFixture({
    id,
    provider: "transport",
    api: "openai-completions",
    baseUrl: BASE_URL,
  });
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  return new Headers(headers).get(name);
}

function authFailureResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "ExpiredTokenException: The security token included in the request is expired",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function completionResponse(text: string) {
  const chunk = {
    id: "transport-response",
    object: "chat.completion.chunk",
    model: "fallback-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("plugin background completion transport", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetCommandQueueStateForTest();
    resetConfigRuntimeState();
    await resetPreparedModelRuntimeSnapshotsForTest();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
  });

  async function withCompletionRuntime(
    run: (complete: () => Promise<{ text: string }>) => Promise<void>,
  ) {
    const roots = createSyncSuiteTempRootTracker("plugin-complete-transport");
    const root = roots.makeTempDir();
    try {
      await withOpenClawTestState(
        {
          prefix: "plugin-complete-transport",
          env: {
            ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
        async (state) => {
          await state.writeAuthProfiles(
            {
              version: 1,
              profiles: {
                other: { type: "api_key", provider: "transport", key: OTHER_KEY },
                pinned: { type: "api_key", provider: "transport", key: PINNED_KEY },
              },
            },
            "research",
          );
          const cfg: OpenClawConfig = {
            agents: {
              defaults: { workspace: state.workspaceDir, model: "transport/fallback-model" },
              entries: {
                research: {
                  model: {
                    primary: "transport/primary-model@pinned",
                    fallbacks: ["transport/fallback-model"],
                  },
                },
              },
            },
            models: {
              providers: {
                transport: {
                  api: "openai-completions",
                  baseUrl: BASE_URL,
                  request: { allowPrivateNetwork: true },
                  models: [providerModel("primary-model"), providerModel("fallback-model")],
                },
              },
            },
            plugins: { slots: { memory: "none" } },
          };
          setRuntimeConfigSnapshot(cfg);
          const lifetime = new AbortController();
          const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
          const complete = () =>
            withPluginRuntimePluginScope({ pluginId: PLUGIN_ID }, () =>
              createGatewaySubagentRuntime(() => context, {}, lifetime.signal).complete({
                agentId: "research",
                message: "Recover from the expired primary.",
                timeoutMs: 15_000,
              }),
            );
          try {
            await withEnvAsync(
              {
                ...state.envVars,
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              },
              async () => await run(complete),
            );
          } finally {
            lifetime.abort();
          }
        },
      );
    } finally {
      roots.cleanup();
    }
  }

  it("recovers through isolated inference without substituting another account for the pinned primary", async () => {
    const hits: RecordedHit[] = [];
    const first = createDeferred();
    const second = createDeferred();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      hits.push({
        url: String(input),
        authorization: headerValue(init?.headers, "authorization"),
      });
      if (hits.length === 1) {
        first.resolve();
        return authFailureResponse();
      }
      second.resolve();
      return completionResponse("fallback-ok");
    });
    await withCompletionRuntime(async (complete) => {
      const recovered = complete();
      await first.promise;
      expect(hits[0]?.authorization).toBe(`Bearer ${PINNED_KEY}`);
      await second.promise;
      await expect(recovered).resolves.toEqual({ text: "fallback-ok" });
      expect(hits).toHaveLength(2);
    });
  });

  it("rejects expired caller authority before the fallback request", async () => {
    const hits: RecordedHit[] = [];
    const first = createDeferred();
    const gate = createDeferred();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      hits.push({
        url: String(_input),
        authorization: headerValue(init?.headers, "authorization"),
      });
      if (hits.length === 1) {
        first.resolve();
        await gate.promise;
        return authFailureResponse();
      }
      return completionResponse("must-not-run");
    });
    await withCompletionRuntime(async (complete) => {
      const profile = ensureProfileForEmail("completion-transport@example.com");
      let pending: Promise<{ text: string }> | undefined;
      await inProcessDispatch.withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: "Completion operator",
            hasAvatar: false,
            updatedAt: 1,
          },
          scopes: ["operator.write"],
        },
        async () => {
          pending = complete();
          await first.promise;
        },
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]?.authorization).toBe(`Bearer ${PINNED_KEY}`);
      gate.resolve();
      await expect(pending).rejects.toThrow(/operator tool invocation authority expired/i);
      expect(hits).toHaveLength(1);
    });
  });
});

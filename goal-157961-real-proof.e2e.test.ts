import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createSessionEntryWithTranscript } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

const sessionKey = "agent:main:main";
const sessionId = "synthetic-goal-proof-session";
const proofDir = process.env.GOAL_PROOF_DIR ?? "/tmp/goal-157961-proof";
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Goal outcome proof through an isolated real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "goal-check-after",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: { model: "fixture/echo", modelPolicy: { allow: ["fixture/*"] } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-responses",
              apiKey: "synthetic-unused-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "echo", name: "Echo" }],
            },
          },
        },
        plugins: { allow: [] },
      },
    });
    try {
      const profile = ensureGatewayOwnerProfile("Synthetic Goal Proof Operator", {
        env: instance.env,
      });
      const now = Date.now();
      const created = await createSessionEntryWithTranscript(
        { agentId: "main", sessionKey, env: instance.env },
        () => ({
          ok: true,
          entry: {
            sessionId,
            updatedAt: now,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: profile.id },
            goal: {
              schemaVersion: 1,
              id: "synthetic-goal",
              objective: "Verify the synthetic deployment",
              status: "active",
              createdAt: now,
              updatedAt: now,
              tokenStart: 0,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          },
        }),
        { cwd: instance.state.workspaceDir },
      );
      expect(created.ok).toBe(true);
      await instance.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        close: () => instance.cleanup(),
      };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("shows the exact outcome check with a real settled Gateway operation", async () => {
    await fs.mkdir(proofDir, { recursive: true });
    const handoff = await instance.cli(["dashboard", "--json"], { timeoutMs: 120_000 });
    expect(handoff.code, handoff.stderr).toBe(0);
    const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
    const url = new URL(browserUrl);
    url.pathname = "/chat/main";
    url.search = "";
    const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
    const responses: Array<{ ok: boolean; replayed: boolean }> = [];
    const requestIndexes = new Map<string, number>();
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            const frame = JSON.parse(message.toString());
            if (frame.type === "req" && frame.method === "sessions.goal.update") {
              requests.push({ id: frame.id, params: frame.params });
              requestIndexes.set(frame.id, requests.length);
            }
            server.send(message);
          });
          server.onMessage((message) => {
            const frame = JSON.parse(message.toString());
            const index = requestIndexes.get(frame.id);
            if (frame.type === "res" && index) {
              responses.push({ ok: frame.ok, replayed: frame.payload?.replayed === true });
              // The real Gateway committed Pause. Lose only its browser ACK.
              if (index === 1) {
                return;
              }
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: {
                    code: "UNAVAILABLE",
                    message: "Synthetic receipt transport interrupted",
                  },
                }),
              );
              return;
            }
            socket.send(message);
          });
        });
        await page.goto(url.href);
        await waitForControlUiGatewayReady(page);
        await page.clock.install();
        await page.getByRole("button", { name: "Pause goal", exact: true }).click();
        const check = page.getByRole("button", { name: "Check outcome", exact: true });
        await expect.poll(() => responses.length).toBe(1);
        const saved = await page.evaluate(() =>
          Object.entries(sessionStorage).find(([key]) =>
            key.startsWith("openclaw.control.goalOperation.v1:"),
          ),
        );
        expect(saved?.[1]).toContain(requests[0]?.params.operationId);
        await page.clock.fastForward(31_000);
        await check.waitFor();
        await expect.poll(() => check.isEnabled()).toBe(true);
        const dismissError = page.locator(".chat-error__dismiss");
        if (await dismissError.count()) {
          await dismissError.click();
        }
        expect(await page.locator(".chat-error").count()).toBe(0);
        await check.click();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[1]?.params).toEqual(requests[0]?.params);
        expect(responses[0]).toEqual({ ok: true, replayed: false });
        await expect.poll(() => responses.length).toBe(2);
        expect(responses[1]).toEqual({ ok: true, replayed: true });
        await page.getByText("Checking goal update…", { exact: true }).waitFor();
        await page.getByText("Checking goal update…", { exact: true }).waitFor({
          state: "detached",
          timeout: 45_000,
        });
        await page.locator(".chat-error").waitFor();
        expect(await check.isEnabled()).toBe(true);
        const errorText = await page.locator(".chat-error").textContent();
        await page.screenshot({
          path: path.join(proofDir, "after.png"),
        });
        await fs.writeFile(
          path.join(proofDir, "after.json"),
          JSON.stringify(
            {
              mode: "patched",
              actualGatewayResponses: responses,
              sameOperationIdentity: true,
              visibleError: Boolean(errorText),
              errorText,
              recoveryControlEnabled: true,
            },
            null,
            2,
          ) + "\n",
        );
      },
    );
  });
});

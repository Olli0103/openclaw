import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as ProviderStreamFamily from "openclaw/plugin-sdk/provider-stream-family";
import { describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderStreamFamily>()),
  getOpenRouterModelCapabilities: (modelId: string) =>
    modelId.startsWith("anthropic/claude-")
      ? {
          name: "Anthropic: Claude Opus 5.5",
          reasoning: true,
          compat: {
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["max", "xhigh", "high", "medium", "low"],
          },
          thinkingLevelMap: { off: null },
          input: ["text", "image"],
          cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }
      : undefined,
}));

describe("OpenRouter configured model capability ownership", () => {
  it.each([
    {
      name: "canonical provider route",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: true,
    },
    {
      name: "legacy endpoint before transport normalization",
      providerBaseUrl: "https://openrouter.ai/v1/",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: false,
    },
    {
      name: "normalized provider key",
      providerKey: "OpenRouter",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: true,
    },
    {
      name: "custom provider endpoint",
      providerBaseUrl: "https://private.example.invalid/v1",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: false,
    },
    {
      name: "custom model endpoint",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: "https://private.example.invalid/v1",
      modelApi: undefined,
      preferred: false,
    },
    {
      name: "custom model API",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: undefined,
      modelApi: "openai-responses",
      preferred: false,
    },
  ])(
    "prefers provider-owned reasoning metadata only on the $name",
    async ({ providerKey, providerBaseUrl, modelBaseUrl, modelApi, preferred }) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const modelId = "anthropic/claude-opus-5.5";
      expect(
        provider.preferRuntimeResolvedModel?.({
          provider: "openrouter",
          modelId,
          config: {
            models: {
              providers: {
                [providerKey ?? "openrouter"]: {
                  baseUrl: providerBaseUrl,
                  models: [
                    {
                      id: modelId,
                      name: modelId,
                      ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
                      ...(modelApi ? { api: modelApi } : {}),
                    },
                  ],
                },
              },
            },
          },
        } as never),
      ).toBe(preferred);
    },
  );

  it.each([
    {
      name: "canonical configured row",
      route: {},
      levels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      name: "row before runtime model resolution",
      modelId: "anthropic/claude-sonnet-5.5",
      route: {},
      levels: undefined,
    },
    {
      name: "custom route",
      route: { baseUrl: "https://private.example.invalid/v1" },
      levels: undefined,
    },
    {
      name: "declared route efforts",
      route: { compat: { supportedReasoningEfforts: ["low", "high"] } },
      levels: ["off", "low", "high"],
    },
  ])("resolves thinking levels for the $name", async ({ modelId, route, levels }) => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    // Session reads must not load the catalog store; runtime resolution records its facts.
    provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-5.5",
    } as never);
    const profile = provider.resolveThinkingProfile?.({
      provider: "openrouter",
      modelId: modelId ?? "anthropic/claude-opus-5.5",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      ...route,
    });
    expect(profile?.levels.map((level) => level.id)).toEqual(levels);
  });
});

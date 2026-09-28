import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

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
});

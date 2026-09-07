import { describe, expect, test } from "bun:test";
import {
  parseRuntimeContexts,
  parseRuntimeModelCatalog,
  registeredModelsWithRuntimeCatalog,
  registeredModelsWithRuntimeContexts,
  runtimeModelsUrl,
} from "../pi-extension/dynamic-context/tools.ts";

describe("dynamic Pi context extension data handling", () => {
  test("accepts numeric max_model_len values and ignores invalid rows", () => {
    expect(
      parseRuntimeContexts({
        data: [
          { id: "qwen", max_model_len: 49_152 },
          { id: "bad-string", max_model_len: "128000" },
          { id: "too-small", max_model_len: 512 },
          { id: "missing" },
        ],
      }),
    ).toEqual(new Map([["qwen", 49_152]]));
  });

  test("preserves the complete static model metadata and only changes contextWindow", () => {
    const models = registeredModelsWithRuntimeContexts(
      {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:18020/v1",
        models: {
          qwen: {
            name: "Qwen",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65_536,
            maxTokens: 16_384,
            compat: { supportsReasoningEffort: false },
          },
          other: {
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 4_000,
          },
        },
      },
      new Map([["qwen", 128_000]]),
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: "qwen",
        name: "Qwen",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsReasoningEffort: false },
      }),
      expect.objectContaining({
        id: "other",
        contextWindow: 32_000,
        maxTokens: 4_000,
      }),
    ]);
  });

  test("builds the configured provider's /v1/models URL", () => {
    expect(runtimeModelsUrl("http://127.0.0.1:18020/v1")).toBe(
      "http://127.0.0.1:18020/v1/models",
    );
  });

  test("discovers llama.cpp profiles and derives context and image capability", () => {
    const catalog = parseRuntimeModelCatalog({
      data: [
        {
          id: "qwen3.8-27b",
          status: { value: "loaded", args: ["--ctx-size", "96000"] },
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "gemma4-26b-a4b-qat",
          status: { value: "unloaded", args: ["--ctx-size", "96000"] },
          architecture: { input_modalities: ["text"] },
        },
        { id: "failed-profile", status: { value: "error" } },
        { id: "default" },
      ],
    });

    expect(catalog).toEqual([
      {
        id: "qwen3.8-27b",
        contextWindow: 96_000,
        input: ["text", "image"],
      },
      {
        id: "gemma4-26b-a4b-qat",
        contextWindow: 96_000,
        input: ["text"],
      },
    ]);

    const models = registeredModelsWithRuntimeCatalog(
      {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: {
          "qwen3.8-27b": {
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 65_536,
            maxTokens: 16_384,
          },
        },
      },
      catalog ?? [],
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: "qwen3.8-27b",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 96_000,
        maxTokens: 16_384,
      }),
      expect.objectContaining({
        id: "gemma4-26b-a4b-qat",
        input: ["text"],
        contextWindow: 96_000,
      }),
    ]);
    expect(models.find((model) => model.id === "gemma4-26b-a4b-qat")?.maxTokens).toBe(16_384);
  });

  test("does not register failed or malformed runtime profiles", () => {
    expect(
      parseRuntimeModelCatalog({
        data: [
          { id: "failed", status: { failed: true } },
          { id: "unavailable", status: "unavailable" },
          { id: 42 },
        ],
      }),
    ).toEqual([]);
    expect(parseRuntimeModelCatalog({ models: [] })).toBeUndefined();
  });

});

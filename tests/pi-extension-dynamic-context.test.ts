import { describe, expect, test } from "bun:test";
import {
  installMidLoopCompactionGuard,
  parseRuntimeContexts,
  registeredModelsWithRuntimeContexts,
  runtimeModelsUrl,
  shouldProactivelyCompact,
  type MidLoopCompactionContext,
  type MidLoopPiApi,
  type MidLoopTurnEvent,
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

  test("uses the live context window and only triggers for continuation turns", () => {
    expect(
      shouldProactivelyCompact(
        "toolUse",
        { tokens: 79_615, contextWindow: 96_000 },
        true,
      ),
    ).toEqual({
      trigger: false,
      currentTokens: 79_615,
      contextWindow: 96_000,
      threshold: 79_616,
    });
    expect(
      shouldProactivelyCompact(
        "toolUse",
        { tokens: 79_616, contextWindow: 96_000 },
        true,
      ).trigger,
    ).toBe(true);
    expect(
      shouldProactivelyCompact(
        "stop",
        { tokens: 95_000, contextWindow: 96_000 },
        true,
      ).trigger,
    ).toBe(false);
    for (const contextWindow of [49_000, 128_000]) {
      const threshold = contextWindow - 16_384;
      expect(
        shouldProactivelyCompact(
          "toolUse",
          { tokens: threshold, contextWindow },
          true,
        ).threshold,
      ).toBe(threshold);
      expect(
        shouldProactivelyCompact(
          "toolUse",
          { tokens: threshold, contextWindow },
          true,
        ).trigger,
      ).toBe(true);
    }
    expect(
      shouldProactivelyCompact(
        "toolUse",
        { tokens: 79_616, contextWindow: 96_000 },
        false,
      ).trigger,
    ).toBe(false);
    expect(
      shouldProactivelyCompact(
        "toolUse",
        { tokens: null, contextWindow: 96_000 },
        true,
      ).trigger,
    ).toBe(false);
  });

  test("installs a one-shot guard, then re-arms only below the threshold", async () => {
    let handler:
      | ((
          event: MidLoopTurnEvent,
          ctx: MidLoopCompactionContext,
        ) => void | Promise<void>)
      | undefined;
    let compactions = 0;
    const pi: MidLoopPiApi = {
      on: (_event, next) => {
        handler = next;
      },
    };
    installMidLoopCompactionGuard(pi);
    expect(handler).toBeDefined();

    let usage = { tokens: 80_000, contextWindow: 96_000 };
    const ctx = {
      getContextUsage: () => usage,
      compact: (options: {
        onComplete?: () => void;
        onError?: (error: Error) => void;
      }) => {
        compactions++;
        options.onComplete?.();
      },
    };
    await handler!({ message: { stopReason: "toolUse" } }, ctx);
    await handler!({ message: { stopReason: "toolUse" } }, ctx);
    expect(compactions).toBe(1);

    usage = { tokens: 60_000, contextWindow: 96_000 };
    await handler!({ message: { stopReason: "toolUse" } }, ctx);
    usage = { tokens: 80_000, contextWindow: 96_000 };
    await handler!({ message: { stopReason: "toolUse" } }, ctx);
    expect(compactions).toBe(2);

    usage = { tokens: 95_000, contextWindow: 96_000 };
    await handler!({ message: { stopReason: "stop" } }, ctx);
    expect(compactions).toBe(2);
  });

  test("does not overlap compactions and leaves a failed guard disarmed", async () => {
    let handler:
      | ((
          event: MidLoopTurnEvent,
          ctx: MidLoopCompactionContext,
        ) => void | Promise<void>)
      | undefined;
    let compactions = 0;
    let finish: (() => void) | undefined;
    const pi: MidLoopPiApi = {
      on: (_event, next) => {
        handler = next;
      },
    };
    installMidLoopCompactionGuard(pi);
    const usage = { tokens: 80_000, contextWindow: 96_000 };
    const first = handler!({ message: { stopReason: "toolUse" } }, {
      getContextUsage: () => usage,
      compact: (options) => {
        compactions++;
        finish = options.onComplete;
      },
    });
    await Promise.resolve();
    await handler!({ message: { stopReason: "toolUse" } }, {
      getContextUsage: () => usage,
      compact: () => {
        compactions++;
      },
    });
    expect(compactions).toBe(1);
    finish?.();
    await first;

    let failedCompactions = 0;
    let failureHandler:
      | ((
          event: MidLoopTurnEvent,
          ctx: MidLoopCompactionContext,
        ) => void | Promise<void>)
      | undefined;
    const failingPi: MidLoopPiApi = {
      on: (_event, next) => {
        failureHandler = next;
      },
    };
    installMidLoopCompactionGuard(failingPi);
    const failingCtx: MidLoopCompactionContext = {
      getContextUsage: () => usage,
      compact: (options) => {
        failedCompactions++;
        options.onError?.(new Error("synthetic compaction failure"));
      },
    };
    await failureHandler!({ message: { stopReason: "toolUse" } }, failingCtx);
    await failureHandler!({ message: { stopReason: "toolUse" } }, failingCtx);
    expect(failedCompactions).toBe(1);
  });
});

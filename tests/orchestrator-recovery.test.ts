/**
 * Tests for the post-failure recovery reply.
 *
 * When the harness chain fails, the channel re-prompts once for a short,
 * language-matched human reply instead of surfacing the raw diagnostic.
 * generateRecoveryReply is the unit that produces that text.
 */

import { describe, expect, test } from "bun:test";

import {
  deterministicFailureReply,
  generateRecoveryReply,
} from "../src/orchestrator/recovery.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

class FakeHarness implements Harness {
  invocations = 0;
  lastRequest?: HarnessRequest;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    this.lastRequest = req;
    for (const c of this.script) yield c;
  }
}

describe("generateRecoveryReply", () => {
  test("provides a safe deterministic fallback when recovery also fails", () => {
    expect(deterministicFailureReply("provider context exceeded")).toContain(
      "context limit was exceeded",
    );
    expect(deterministicFailureReply("request mentioned context in a note")).toBe(
      "The model could not complete this turn, and the automatic recovery response also failed. Please retry.",
    );
    expect(deterministicFailureReply("provider unavailable")).toBe(
      "The model could not complete this turn, and the automatic recovery response also failed. Please retry.",
    );
  });

  test("returns the harness's recovery text", async () => {
    const harness = new FakeHarness("fake", [
      { type: "text", text: "Hit a snag — mind trying again?" },
      { type: "done", finalText: "Hit a snag — mind trying again?" },
    ]);
    const out = await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "what's my balance?",
      personaName: "Robbie",
    });
    expect(out).toBe("Hit a snag — mind trying again?");
    expect(harness.invocations).toBe(1);
  });

  test("trims whitespace and prefers final text", async () => {
    const harness = new FakeHarness("fake", [
      { type: "text", text: "partial" },
      { type: "done", finalText: "  Final clean reply.  " },
    ]);
    const out = await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "hi",
    });
    expect(out).toBe("Final clean reply.");
  });

  test("passes the original user message through (for language matching)", async () => {
    const harness = new FakeHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);
    await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "hola, ¿cómo estás?",
    });
    expect(harness.lastRequest?.userMessage).toBe("hola, ¿cómo estás?");
    // Recovery runs with no history and a tool-forbidding system prompt.
    expect(harness.lastRequest?.history).toEqual([]);
    expect(harness.lastRequest?.systemPrompt).toContain("Do NOT use any tools");
  });

  test("passes canonical history so context-dependent failures are reportable", async () => {
    const harness = new FakeHarness("fake", [
      { type: "done", finalText: "I hit a snag; I can continue from the current state." },
    ]);
    const history = [
      { role: "user" as const, text: "Fix the failing test in the repository." },
      { role: "assistant" as const, text: "I am inspecting it." },
    ];
    await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "continue with that",
      history,
    });
    expect(harness.lastRequest?.history).toEqual(history);
    expect(harness.lastRequest?.userMessage).toBe("continue with that");
    expect(harness.lastRequest?.systemPrompt).toContain(
      "Do NOT ask them to repeat details already present",
    );
  });

  test("returns undefined when the recovery turn itself errors", async () => {
    const harness = new FakeHarness("fake", [
      { type: "error", error: "still broken", recoverable: true },
    ]);
    const out = await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "hi",
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined for an empty reply", async () => {
    const harness = new FakeHarness("fake", [
      { type: "done", finalText: "   " },
    ]);
    const out = await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "hi",
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined with no harnesses", async () => {
    const out = await generateRecoveryReply({
      harnesses: [],
      userMessage: "hi",
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined immediately if already aborted", async () => {
    const harness = new FakeHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const out = await generateRecoveryReply({
      harnesses: [harness],
      userMessage: "hi",
      signal: AbortSignal.abort(),
    });
    expect(out).toBeUndefined();
    expect(harness.invocations).toBe(0);
  });
});

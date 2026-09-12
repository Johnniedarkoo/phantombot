import { describe, expect, test } from "bun:test";
import { HarnessDiagnostics } from "../src/lib/harnessDiagnostics.ts";

describe("HarnessDiagnostics", () => {
  test("clears a completed tool and preserves its lifecycle", () => {
    const d = new HarnessDiagnostics();
    d.toolStart("web_search", "12");
    expect(d.snapshot()).toMatchObject({ activeTool: "web_search", activeToolCallId: "12", toolCallsStarted: 1 });
    d.toolEnd();
    expect(d.snapshot()).toMatchObject({ lastEvent: "tool_end", toolCallsCompleted: 1 });
    expect(d.snapshot().activeTool).toBeUndefined();
  });

  test("identifies silence during a tool versus after it", () => {
    const during = new HarnessDiagnostics();
    during.toolStart("web_search", "12");
    expect(during.snapshot()).toMatchObject({ activeTool: "web_search", activeToolCallId: "12", lastEvent: "tool_start" });

    const after = new HarnessDiagnostics();
    after.toolStart("web_search", "12");
    after.toolEnd();
    expect(after.snapshot()).toMatchObject({ activeTool: undefined, lastEvent: "tool_end", toolCallsCompleted: 1 });
  });

  test("keeps cache bytes and token metadata as separate fields at call sites", () => {
    const d = new HarnessDiagnostics();
    expect(d.snapshot()).not.toHaveProperty("promptTokens");
    expect(d.snapshot()).not.toHaveProperty("promptCacheBytes");
  });
});

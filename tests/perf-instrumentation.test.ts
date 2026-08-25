import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PiHarness,
  observePiEvent,
  parsePiEvent,
  timedParsePiEvent,
  type PiEventTimings,
} from "../src/harnesses/pi.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { runTurn } from "../src/orchestrator/turn.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import { perfTrace } from "../src/lib/perfTrace.ts";
import * as vault from "../src/lib/vault.ts";

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = original; } };
}

function perfRecords(lines: string[], msg: string): Record<string, unknown>[] {
  return lines
    .flatMap((line) => line.trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.msg === msg);
}

class FakeHarness implements Harness {
  readonly id = "fake";
  async available(): Promise<boolean> { return true; }
  async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    yield { type: "text", text: "OK" };
    yield { type: "done", finalText: "OK" };
  }
}

let originalTrace: string | undefined;
let stderr: ReturnType<typeof captureStderr>;

beforeEach(() => {
  originalTrace = process.env.PHANTOMBOT_PERF_TRACE;
  stderr = captureStderr();
});

afterEach(() => {
  if (originalTrace === undefined) delete process.env.PHANTOMBOT_PERF_TRACE;
  else process.env.PHANTOMBOT_PERF_TRACE = originalTrace;
  stderr.restore();
});

describe("opt-in perf tracing", () => {
  test("tracing disabled emits no perf output", () => {
    delete process.env.PHANTOMBOT_PERF_TRACE;
    perfTrace("perf.turn", { turnId: "disabled" });
    expect(perfRecords(stderr.lines, "perf.turn")).toEqual([]);
  });

  test("an enabled real turn emits a summary without private text", async () => {
    process.env.PHANTOMBOT_PERF_TRACE = "1";
    const agentDir = await mkdtemp(join(tmpdir(), "phantombot-perf-turn-"));
    const memory: MemoryStore = await openMemoryStore(":memory:");
    try {
      await writeFile(join(agentDir, "BOOT.md"), "# Test persona", "utf8");
      const chunks: HarnessChunk[] = [];
      for await (const chunk of runTurn({
        persona: "phantom",
        conversation: "perf:enabled",
        userMessage: "PRIVATE USER MESSAGE",
        agentDir,
        workingDir: agentDir,
        memory,
        idleTimeoutMs: 1_000,
        harnesses: [new FakeHarness()],
      })) chunks.push(chunk);

      const records = perfRecords(stderr.lines, "perf.turn");
      expect(chunks.map((chunk) => chunk.type)).toEqual(["text", "done"]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        turnId: expect.any(String),
        history_turns: 0,
        user_message_bytes: Buffer.byteLength("PRIVATE USER MESSAGE", "utf8"),
      });
      expect(JSON.stringify(records[0])).not.toContain("PRIVATE USER MESSAGE");
      expect(JSON.stringify(records[0])).not.toContain("# Test persona");
    } finally {
      await memory.close();
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  test("the perf field allowlist drops private fields", () => {
    process.env.PHANTOMBOT_PERF_TRACE = "1";
    perfTrace("perf.turn", {
      turnId: "safe-turn",
      history_bytes: 10,
      prompt_text: "PRIVATE PROMPT",
      answer_text: "PRIVATE ANSWER",
      tool_args: "PRIVATE TOOL ARGS",
    });
    const raw = JSON.stringify(perfRecords(stderr.lines, "perf.turn")[0]);
    expect(raw).toContain("safe-turn");
    expect(raw).not.toContain("PRIVATE");
    expect(raw).not.toContain("prompt_text");
  });
});

describe("Pi lifecycle observation", () => {
  test("detects lifecycle boundaries and preserves parsePiEvent output", () => {
    const timings: PiEventTimings = {};
    const parser = timedParsePiEvent(timings);
    const events: unknown[] = [
      { type: "session" },
      { type: "agent_start" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } },
      { type: "turn_end" },
    ];
    for (const event of events) {
      expect(parser(event)).toEqual(parsePiEvent(event));
    }
    expect(timings.firstRawAt).toBeDefined();
    expect(timings.agentStartAt).toBeDefined();
    expect(timings.firstModelDeltaAt).toBeDefined();
    expect(timings.firstTextDeltaAt).toBeDefined();
    expect(timings.turnEndAt).toBeDefined();
  });

  test("independent turn timing state cannot mix under interleaving", () => {
    const first: PiEventTimings = {};
    const second: PiEventTimings = {};
    observePiEvent({ type: "session" }, first, 10);
    observePiEvent({ type: "session" }, second, 20);
    observePiEvent({ type: "agent_start" }, first, 30);
    observePiEvent({ type: "agent_start" }, second, 40);
    observePiEvent({ type: "turn_end" }, second, 50);
    observePiEvent({ type: "turn_end" }, first, 60);
    expect(first).toEqual({ firstRawAt: 10, agentStartAt: 30, turnEndAt: 60 });
    expect(second).toEqual({ firstRawAt: 20, agentStartAt: 40, turnEndAt: 50 });
  });
});

describe("Pi retry perf records", () => {
  const originalMode = process.env.FAKE_PI_MODE;
  const originalFailModel = process.env.FAKE_PI_FAIL_MODEL;
  let vaultReloadSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.FAKE_PI_MODE;
    else process.env.FAKE_PI_MODE = originalMode;
    if (originalFailModel === undefined) delete process.env.FAKE_PI_FAIL_MODEL;
    else process.env.FAKE_PI_FAIL_MODEL = originalFailModel;
    vaultReloadSpy?.mockRestore();
  });

  test("coder retries get distinct attempt numbers and kinds", async () => {
    process.env.PHANTOMBOT_PERF_TRACE = "1";
    process.env.FAKE_PI_MODE = "modelgate";
    process.env.FAKE_PI_FAIL_MODEL = "z-ai/glm-5.2";
    vaultReloadSpy = spyOn(vault, "reloadVaultForPersona").mockResolvedValue(undefined as never);
    const fakePi = join(import.meta.dir, "fixtures", "fake-pi-perf.cmd");
    const harness = new PiHarness({
      bin: fakePi,
      routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
    });
    const request: HarnessRequest = {
      systemPrompt: "system",
      userMessage: "review this pull request https://github.com/x/y/pull/1",
      history: [],
      persona: "phantom",
      conversation: "perf:retry",
      turnId: "retry-turn",
      workingDir: process.cwd(),
      idleTimeoutMs: 5_000,
      hardTimeoutMs: 5_000,
    };
    for await (const _chunk of harness.invoke(request)) { /* drain */ }
    const records = perfRecords(stderr.lines, "perf.pi_attempt");
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.attempt)).toEqual([1, 2, 3, 4]);
    expect(records.map((record) => record.attempt_kind)).toEqual([
      "coder", "coder", "coder", "primary",
    ]);
    expect(records.every((record) => record.turnId === "retry-turn")).toBe(true);
  });
});

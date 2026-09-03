import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createPiTrace } from "../src/lib/piDiagnostics.ts";
import { runHarnessProcess } from "../src/lib/harnessRunner.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi diagnostic traces", () => {
  test("persists raw streams and structured completion state without writing argv secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "phantombot-pi-trace-test-"));
    tempDirs.push(root);
    const trace = await createPiTrace({
      rootDir: root,
      outerPid: 123,
      harnessId: "pi",
      turnId: "turn-1",
      persona: "phantom",
      conversation: "test",
      workingDir: root,
      model: "qwen3.8-27b",
      provider: "vllm",
      argv: ["pi", "--api-key", "secret-value", "@payload.md"],
      env: {
        PHANTOMBOT_PI_API_KEY: "secret-value",
        PHANTOMBOT_TURN_ID: "turn-1",
      },
      payloadBytes: 42,
      idleTimeoutMs: 1000,
    });
    expect(trace).toBeDefined();

    trace!.recordStdout(
      '{"type":"message_end","message":{"role":"assistant","stopReason":"length","usage":{"input":10,"output":2}}}',
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "length",
          usage: { input: 10, output: 2 },
        },
      },
    );
    trace!.recordStdout('{"type":"compaction_end","willRetry":false}', {
      type: "compaction_end",
      willRetry: false,
    });
    trace!.recordStderr("stderr line");
    trace!.recordChunk({ type: "error", error: "stopped", recoverable: true });
    await trace!.close({ childPid: 456, childExitCode: 0, childSignal: undefined });

    const events = await readFile(join(trace!.dir, "events.jsonl"), "utf8");
    const summary = JSON.parse(await readFile(join(trace!.dir, "summary.json"), "utf8")) as Record<string, any>;
    const metadata = await readFile(join(trace!.dir, "metadata.json"), "utf8");

    expect(events).toContain('"kind":"stdout"');
    expect(events).toContain("compaction_end");
    expect(events).toContain('"raw":"stderr line"');
    expect(summary.childExitCode).toBe(0);
    expect(summary.lastStopReason).toBe("length");
    expect(summary.lifecycle).toEqual(["message_end", "compaction_end"]);
    expect(metadata).toContain('"--api-key"');
    expect(metadata).toContain('"[redacted]"');
    expect(metadata).not.toContain("secret-value");
  });

  test("harness runner forwards every stdout line to the diagnostic hook", async () => {
    const lines: string[] = [];
    const encoded = new TextEncoder().encode('{"type":"turn_end"}\nplain progress\n');
    const proc = {
      pid: 456,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      signalCode: null,
    } as any;

    const chunks: unknown[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "pi",
      req: {
        idleTimeoutMs: 1000,
        hardTimeoutMs: 2000,
        workingDir: process.cwd(),
      } as any,
      parseEvent: (parsed) =>
        (parsed as { type?: string }).type === "turn_end"
          ? { type: "done", finalText: "", meta: {} }
          : undefined,
      activity: () => "productive",
      onStdoutLine: (line) => lines.push(line),
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }

    expect(lines).toEqual(['{"type":"turn_end"}', "plain progress"]);
    expect(chunks).toEqual([{ type: "progress", note: "plain progress" }, { type: "done", finalText: "", meta: {} }]);
  });
});

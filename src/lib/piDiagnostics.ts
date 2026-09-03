/**
 * Compact Pi invocation tracing for diagnosing interrupted --print runs.
 *
 * Every Pi harness attempt gets a small trace directory containing
 * metadata.json, events.jsonl, and summary.json. Raw stdout/stderr is retained
 * only when the operator explicitly sets PHANTOMBOT_PI_TRACE_DIR; the default
 * trace is deliberately summary-only so prompts and tool results do not enter
 * the normal diagnostic log.
 */

import { appendFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "./logger.ts";

export interface PiTraceOptions {
  rootDir: string;
  outerPid: number;
  harnessId: string;
  turnId?: string;
  persona?: string;
  conversation?: string;
  workingDir?: string;
  model?: string;
  provider?: string;
  argv: string[];
  env: Record<string, string | undefined>;
  payloadBytes: number;
  idleTimeoutMs: number;
  hardTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Keep raw Pi stdout/stderr lines (explicit diagnostic opt-in only). */
  captureRaw?: boolean;
  /** Invocation number within this logical harness call (1-based). */
  invocationNumber?: number;
}

export interface PiTrace {
  readonly dir: string;
  recordStdout(line: string, parsed?: unknown): void;
  recordStderr(line: string): void;
  recordChunk(chunk: Record<string, unknown>): void;
  record(kind: string, fields?: Record<string, unknown>): void;
  close(summary: Record<string, unknown>): Promise<void>;
}

const activeTraces = new Set<PiTraceImpl>();
let processObserversInstalled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map(safeValue);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      result[key] = safeValue(item);
    }
    return result;
  }
  return String(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageTextStats(message: Record<string, unknown>): Record<string, number> {
  const content = Array.isArray(message.content) ? message.content : [];
  let visibleTextChars = 0;
  let thinkingChars = 0;
  let toolCalls = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") visibleTextChars += part.text.length;
    if (part.type === "thinking" && typeof part.thinking === "string") thinkingChars += part.thinking.length;
    if (part.type === "toolCall") toolCalls++;
  }
  return { visibleTextChars, thinkingChars, toolCalls };
}

function eventSummary(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  const message = isRecord(parsed.message) ? parsed.message : undefined;
  const summary: Record<string, unknown> = {};
  if (typeof parsed.type === "string") summary.type = parsed.type;
  for (const key of [
    "stopReason",
    "willRetry",
    "retry",
    "usage",
    "model",
    "provider",
    "contextWindow",
    "maxTokens",
    "effectiveMaxTokens",
    "errorMessage",
    "reason",
    "tokensBefore",
    "tokensAfter",
    "estimatedTokensAfter",
  ]) {
    if (key in parsed) summary[key] = safeValue(parsed[key]);
    else if (message && key in message) summary[`message_${key}`] = safeValue(message[key]);
  }
  if (message) {
    if (typeof message.role === "string") summary.messageRole = message.role;
    if (typeof message.model === "string") summary.messageModel = message.model;
    if (typeof message.provider === "string") summary.messageProvider = message.provider;
    for (const key of ["contextWindow", "maxTokens", "effectiveMaxTokens"]) {
      if (key in message) summary[`message_${key}`] = safeValue(message[key]);
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function redactedArgv(argv: string[]): string[] {
  const result: string[] = [];
  let redactNext = false;
  for (const arg of argv) {
    if (redactNext) {
      result.push("[redacted]");
      redactNext = false;
      continue;
    }
    result.push(arg);
    if (/^(--api-key|--token|--password|--secret)$/i.test(arg)) redactNext = true;
  }
  return result;
}

function diagnosticEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^(PHANTOMBOT_|PI_)/i.test(key)) continue;
    result[key] = /key|token|secret|password|credential/i.test(key)
      ? "[redacted]"
      : value ?? "";
  }
  return result;
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: safeValue(error) };
}

function now(): string {
  return new Date().toISOString();
}

class PiTraceImpl implements PiTrace {
  readonly dir: string;
  private readonly eventsPath: string;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private writeFailureLogged = false;
  private lastEvent: Record<string, unknown> | undefined;
  private lastUsage: unknown;
  private lastStopReason: unknown;
  private lifecycle: string[] = [];
  private readonly modelCalls: Array<Record<string, unknown>> = [];
  private textDeltaChars = 0;
  private thinkingDeltaChars = 0;
  private toolExecutionStarts = 0;
  private stderrChars = 0;

  constructor(private readonly options: PiTraceOptions, dir: string) {
    this.dir = dir;
    this.eventsPath = join(dir, "events.jsonl");
  }

  record(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const line = JSON.stringify({ ts: now(), kind, ...fields }) + "\n";
    this.pending = this.pending
      .then(() => appendFile(this.eventsPath, line, "utf8"))
      .catch((error) => {
        if (!this.writeFailureLogged) {
          this.writeFailureLogged = true;
          log.warn("pi trace write failed", {
            dir: this.dir,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
  }

  recordStdout(line: string, parsed?: unknown): void {
    const summary = eventSummary(parsed);
    if (summary) {
      this.lastEvent = summary;
      if (typeof summary.type === "string") {
        this.lifecycle.push(summary.type);
        if (this.lifecycle.length > 128) this.lifecycle.shift();
      }
      if ("usage" in summary) this.lastUsage = summary.usage;
      if ("message_usage" in summary) this.lastUsage = summary.message_usage;
      if ("stopReason" in summary) this.lastStopReason = summary.stopReason;
      if ("message_stopReason" in summary) this.lastStopReason = summary.message_stopReason;

      const type = summary.type;
      const record = isRecord(parsed) ? parsed : undefined;
      const message = record && isRecord(record.message) ? record.message : undefined;
      if (type === "message_update" && record) {
        const assistantEvent = isRecord(record.assistantMessageEvent)
          ? record.assistantMessageEvent
          : undefined;
        const delta = assistantEvent?.delta;
        if (assistantEvent?.type === "text_delta" && typeof delta === "string") {
          this.textDeltaChars += delta.length;
        } else if (
          typeof assistantEvent?.type === "string" &&
          assistantEvent.type.includes("thinking") &&
          typeof delta === "string"
        ) {
          this.thinkingDeltaChars += delta.length;
        }
      }
      if (type === "tool_execution_start") this.toolExecutionStarts++;

      if (type === "message_start" && message?.role === "assistant") {
        const call: Record<string, unknown> = {
          call: this.modelCalls.length + 1,
          startedAt: now(),
          model: stringValue(message.model) ?? stringValue(record?.model),
          provider: stringValue(message.provider) ?? stringValue(record?.provider),
          contextWindow: numeric(message.contextWindow) ?? numeric(record?.contextWindow),
          configuredMaxTokens: numeric(message.maxTokens) ?? numeric(record?.maxTokens),
          effectiveMaxTokens:
            numeric(message.effectiveMaxTokens) ?? numeric(record?.effectiveMaxTokens),
        };
        const cleaned = Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined));
        this.modelCalls.push(cleaned);
        this.record("model_call_start", cleaned);
      }
      if (type === "message_end" && message?.role === "assistant") {
        const usage = isRecord(message.usage) ? message.usage : undefined;
        const stats = messageTextStats(message);
        const existing = this.modelCalls.at(-1) ?? { call: this.modelCalls.length + 1 };
        const ended: Record<string, unknown> = {
          ...existing,
          endedAt: now(),
          model: existing.model ?? stringValue(message.model) ?? stringValue(record?.model),
          provider: existing.provider ?? stringValue(message.provider) ?? stringValue(record?.provider),
          stopReason: stringValue(message.stopReason) ?? stringValue(record?.stopReason),
          inputTokens: numeric(usage?.input),
          outputTokens: numeric(usage?.output),
          reasoningTokens: numeric(usage?.reasoning),
          cachedInputTokens: numeric(usage?.cacheRead),
          cacheWriteTokens: numeric(usage?.cacheWrite),
          totalTokens: numeric(usage?.totalTokens),
          ...stats,
        };
        const cleaned = Object.fromEntries(Object.entries(ended).filter(([, v]) => v !== undefined));
        if (this.modelCalls.length === 0) this.modelCalls.push(cleaned);
        else this.modelCalls[this.modelCalls.length - 1] = cleaned;
        this.record("model_call_end", cleaned);
      }

      // Keep compact traces bounded: lifecycle markers and model summaries are
      // useful; per-token message_update events are not.
      if (type !== "message_update" && type !== "session") {
        this.record("pi_event", { event: summary });
      }
    }
    if (this.options.captureRaw) {
      this.record("stdout", {
        raw: line,
        ...(summary ? { event: summary } : {}),
      });
    }
  }

  recordStderr(line: string): void {
    this.stderrChars += line.length;
    this.record("stderr", {
      chars: line.length,
      ...(this.options.captureRaw ? { raw: line } : {}),
    });
  }

  recordChunk(chunk: Record<string, unknown>): void {
    const safe = { ...chunk };
    delete safe.stderrTail;
    delete safe.finalText;
    this.record("harness_chunk", safe);
  }

  async close(summary: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    this.record("process_exit", {
      pid: summary.childPid,
      exitCode: summary.childExitCode,
      signal: summary.childSignal,
    });
    this.record("trace_end", {
      ...summary,
      lastEvent: this.lastEvent,
      lastUsage: this.lastUsage,
      lastStopReason: this.lastStopReason,
      lastModelCall: this.modelCalls.at(-1),
      lifecycle: this.lifecycle,
      modelCalls: this.modelCalls,
      counters: {
        textDeltaChars: this.textDeltaChars,
        thinkingDeltaChars: this.thinkingDeltaChars,
        toolExecutionStarts: this.toolExecutionStarts,
        stderrChars: this.stderrChars,
      },
    });
    await this.pending;
    this.closed = true;
    activeTraces.delete(this);
    try {
      await writeFile(
        join(this.dir, "summary.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            ...summary,
            lastEvent: this.lastEvent,
            lastUsage: this.lastUsage,
            lastStopReason: this.lastStopReason,
            lastModelCall: this.modelCalls.at(-1),
            lifecycle: this.lifecycle,
            modelCalls: this.modelCalls,
            counters: {
              textDeltaChars: this.textDeltaChars,
              thinkingDeltaChars: this.thinkingDeltaChars,
              toolExecutionStarts: this.toolExecutionStarts,
              stderrChars: this.stderrChars,
            },
            diagnostics: {
              requestBudget: "Pi JSON mode does not expose the outbound effective max_tokens value",
              contextWindow: "not present in Pi JSON lifecycle events unless supplied by the provider",
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    } catch (error) {
      log.warn("pi trace summary write failed", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  syncRecord(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    try {
      appendFileSync(
        this.eventsPath,
        JSON.stringify({ ts: now(), kind, ...fields }) + "\n",
        "utf8",
      );
    } catch {
      // Process exit is already in progress; never throw from an exit hook.
    }
  }

  metadata(): Record<string, unknown> {
    const o = this.options;
    return {
      schemaVersion: 1,
      traceDir: this.dir,
      harnessId: o.harnessId,
      outerProcess: {
        pid: o.outerPid,
        role: "PhantomBot daemon hosting the async turn worker",
        exit: "not observable from a child harness trace",
      },
      turn: {
        id: o.turnId,
        persona: o.persona,
        conversation: o.conversation,
        workingDir: o.workingDir,
      },
      model: o.model,
      provider: o.provider,
      invocationNumber: o.invocationNumber,
      rawCapture: o.captureRaw === true,
      payloadBytes: o.payloadBytes,
      timeouts: {
        idleMs: o.idleTimeoutMs,
        hardMs: o.hardTimeoutMs,
        startupMs: o.startupTimeoutMs,
      },
      command: redactedArgv(o.argv),
      environment: diagnosticEnv(o.env),
      startedAt: now(),
    };
  }
}

export async function createPiTrace(options: PiTraceOptions): Promise<PiTrace | undefined> {
  const root = options.rootDir.trim();
  if (!root) return undefined;
  const stamp = now().replace(/[:.]/g, "-");
  const dir = join(root, `${stamp}-${options.turnId ?? "no-turn"}-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    const trace = new PiTraceImpl(
      { ...options, captureRaw: options.captureRaw ?? true },
      dir,
    );
    await writeFile(join(dir, "metadata.json"), JSON.stringify(trace.metadata(), null, 2) + "\n", "utf8");
    activeTraces.add(trace);
    installPiTraceProcessObservers();
    trace.record("spawn_plan", {
      pid: undefined,
      command: redactedArgv(options.argv),
    });
    return trace;
  } catch (error) {
    log.warn("pi trace setup failed; continuing without trace", {
      root,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function recordProcessEvent(kind: string, fields: Record<string, unknown>): void {
  for (const trace of activeTraces) trace.record(kind, fields);
}

export function installPiTraceProcessObservers(): void {
  if (processObserversInstalled) return;
  processObserversInstalled = true;
  const p = process as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    prependListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    listeners?: (event: string) => Function[];
  };
  // Monitor does not replace Node/Bun's normal uncaught-exception behavior.
  p.on("uncaughtExceptionMonitor", (error) => {
    recordProcessEvent("outer_uncaught_exception", { error: errorSummary(error) });
  });
  // This hook is installed only while explicit tracing is enabled. If the
  // application already has a rejection guard (PhantomBot's P2P guard does),
  // leave that policy in charge. If it does not, rethrow on the next turn so
  // adding diagnostics cannot turn an otherwise-fatal rejection into a quiet
  // daemon failure.
  const hadUnhandledRejectionGuard = (p.listeners?.("unhandledRejection").length ?? 0) > 0;
  const observeUnhandledRejection = (reason: unknown, promise: unknown) => {
    recordProcessEvent("outer_unhandled_rejection", {
      reason: errorSummary(reason),
      promise: String(promise),
    });
    if (!hadUnhandledRejectionGuard) {
      setTimeout(() => {
        throw reason;
      }, 0);
    }
  };
  (p.prependListener ?? p.on).call(p, "unhandledRejection", observeUnhandledRejection);
  p.on("exit", (code) => {
    for (const trace of activeTraces) {
      if (trace instanceof PiTraceImpl) {
        trace.syncRecord("outer_process_exit", { pid: process.pid, code });
      }
    }
  });
}

export function traceError(error: unknown): Record<string, unknown> {
  return errorSummary(error);
}

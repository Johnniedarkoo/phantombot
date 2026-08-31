/**
 * Productive hard-boundary continuation.
 *
 * This is deliberately separate from idle-wedge resume.  An idle resume is a
 * recovery from a silent process; this path is a single, bounded continuation
 * after the absolute wall-clock ceiling stopped a process that was still doing
 * useful work.
 */

import type {
  HarnessChunk,
  HarnessExecutionInfo,
  HarnessRequest,
} from "../harnesses/types.ts";
import { PartialAttempt } from "./resume.ts";

/** At most one continuation after a productive hard boundary. */
export const MAX_HARD_CONTINUATIONS = 1;

const MAX_NARRATION_CHARS = 2_000;
const MAX_TOOL_CALLS = 20;

/**
 * The previous idle window is the narrowest useful definition of "recent".
 * If meaningful work happened within that window, the process would not have
 * been idle-killed; requiring the same recency here prevents old output from
 * qualifying an otherwise stale hour-long run.
 */
export function hasRecentProductiveActivity(
  partial: PartialAttempt,
  now: number,
  activityWindowMs: number,
): boolean {
  const last = partial.lastProductiveAt;
  if (last === undefined) return false;
  return now - last <= Math.max(1, activityWindowMs);
}

export function shouldContinueAfterHardTimeout(
  chunk: HarnessChunk,
  partial: PartialAttempt,
  continuationsUsed: number,
  now: number,
  activityWindowMs: number,
): boolean {
  if (chunk.type !== "error") return false;
  if (chunk.killCause !== "timeout") return false;
  if (chunk.recoverable === false || chunk.terminal) return false;
  if (!partial.producedOutput) return false;
  if (
    !hasRecentProductiveActivity(partial, now, activityWindowMs)
  ) return false;
  return continuationsUsed < MAX_HARD_CONTINUATIONS;
}

export interface HardContinuationState {
  elapsedMs: number;
  continuationNumber: number;
  execution?: HarnessExecutionInfo;
  /** State from an earlier attempt in the same harness slot, if any. */
  priorNarration?: string;
  priorToolCalls?: readonly string[];
  priorDroppedToolCalls?: number;
}

function boundedNarration(
  partial: PartialAttempt,
  priorNarration: string | undefined,
): string {
  const text = [priorNarration?.trim(), partial.text]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return text.length > MAX_NARRATION_CHARS
    ? `…${text.slice(-MAX_NARRATION_CHARS)}`
    : text;
}

function boundedToolCalls(
  partial: PartialAttempt,
  state: HardContinuationState,
): { calls: string[]; dropped: number } {
  const all = [...(state.priorToolCalls ?? []), ...partial.toolCalls];
  const overflow = Math.max(0, all.length - MAX_TOOL_CALLS);
  return {
    calls: all.slice(-MAX_TOOL_CALLS),
    dropped:
      (state.priorDroppedToolCalls ?? 0) + partial.droppedToolCalls + overflow,
  };
}

/** Build the verify-first prompt for a productive hard-boundary continuation. */
export function buildHardContinuationPreamble(
  partial: PartialAttempt,
  state: HardContinuationState,
): string {
  const lines = [
    "[phantombot — bounded continuation of an interrupted turn]",
    "",
    "The previous process was stopped by PhantomBot's hard execution boundary",
    "while working on this SAME user request. Continue the original task; do",
    "not ask the user to repeat it or restart the task from scratch.",
    "",
    `This is continuation ${state.continuationNumber} after approximately ${state.elapsedMs}ms of work.`,
    "The previous process performed work and tool side effects may already have",
    "applied. Before repeating edits, commands, commits, or other side effects,",
    "inspect the current state and VERIFY what has already been completed.",
  ];

  const said = boundedNarration(partial, state.priorNarration);
  if (said) {
    lines.push(
      "",
      "The user may already have seen this progress; do not repeat it unnecessarily:",
      "---",
      said,
      "---",
    );
  }

  const { calls, dropped } = boundedToolCalls(partial, state);
  if (calls.length > 0) {
    lines.push("", "These tool calls were started before the interruption:");
    for (const call of calls) lines.push(`  - ${call}`);
    if (dropped > 0) lines.push(`  - (…and ${dropped} more, not listed)`);
    lines.push(
      "",
      "Their results are uncertain. VERIFY the current repository/system state",
      "before redoing any call that changes anything.",
    );
  }

  lines.push(
    "",
    "Use the existing working directory and conversation context. Inspect first,",
    "then continue and finish the user's original task.",
  );
  return lines.join("\n");
}

/** Preserve the original request envelope while appending bounded state. */
export function buildHardContinuationRequest(
  req: HarnessRequest,
  partial: PartialAttempt,
  state: HardContinuationState,
): HarnessRequest {
  const continued: HarnessRequest = {
    ...req,
    userMessage: `${req.userMessage}\n\n${buildHardContinuationPreamble(partial, state)}`,
  };
  if (state.execution) continued.execution = state.execution;
  return continued;
}

/** Deterministic result used when the one continuation also hits a boundary. */
export const HARD_CONTINUATION_EXHAUSTED_MESSAGE =
  "I hit the execution limit again while continuing this task. Work already performed may be partially applied, so I stopped rather than repeating it blindly.";

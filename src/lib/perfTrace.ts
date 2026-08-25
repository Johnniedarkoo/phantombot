/**
 * Opt-in, privacy-safe timing records for bounded performance campaigns.
 *
 * This is deliberately a thin wrapper around the existing structured logger.
 * Callers must provide only non-sensitive fields (durations, counts, and
 * identifiers); prompt, history, tool, and model-output text do not belong in
 * perf records.
 */

import { log } from "./logger.ts";

const PERF_FIELDS: Record<string, ReadonlySet<string>> = {
  "perf.turn": new Set([
    "turnId",
    "turn_total_ms",
    "turn_prepare_ms",
    "persona_load_ms",
    "history_load_ms",
    "screen_ms",
    "retrieval_ms",
    "durable_facts_ms",
    "daily_recall_ms",
    "prompt_build_ms",
    "history_turns",
    "history_bytes",
    "system_prompt_bytes",
    "user_message_bytes",
    "turn_to_first_text_ms",
  ]),
  "perf.pi_attempt": new Set([
    "turnId",
    "model",
    "attempt",
    "attempt_kind",
    "pi_invoke_prepare_ms",
    "pi_spawn_call_ms",
    "pi_spawn_to_first_raw_ms",
    "pi_first_raw_to_agent_start_ms",
    "pi_agent_start_to_first_model_delta_ms",
    "pi_spawn_to_first_model_delta_ms",
    "pi_spawn_to_first_text_ms",
    "pi_attempt_total_ms",
    "payload_bytes",
    "history_turns",
  ]),
};

export function perfTraceEnabled(): boolean {
  return process.env.PHANTOMBOT_PERF_TRACE === "1";
}

export function perfNow(): number {
  return performance.now();
}

export function elapsedMs(start: number, end = perfNow()): number {
  return Math.round((end - start) * 10) / 10;
}

/**
 * Emit a perf record without allowing diagnostics to change turn behaviour.
 */
export function perfTrace(
  msg: string,
  fields: Record<string, unknown>,
): void {
  if (!perfTraceEnabled()) return;
  try {
    const allowed = PERF_FIELDS[msg];
    if (!allowed) return;
    const safeFields = Object.fromEntries(
      Object.entries(fields).filter(([key]) => allowed.has(key)),
    );
    log.info(msg, safeFields);
  } catch {
    // Perf logging is observational only. A broken stderr sink must not break
    // the turn being measured.
  }
}

# Pi time-to-first-token instrumentation campaign

Status: design / measurement campaign only

Target branch: `perf/pi-ttft-instrumentation`

Starting point: `Johnniedarkoo/phantombot@b14c80cf98b9dc62a0a153c9a66ea2c58ad3930d` (the current OpenAI-compatible embeddings feature head, so measurements include the live semantic-retrieval path without modifying that PR branch).

## Goal

Measure where interactive Pi-backed PhantomBot latency is spent before the model begins responding.

Working hypothesis:

```text
channel receives message
  -> runTurn setup / memory / prompt assembly
  -> Pi harness builds temp files and per-turn env
  -> spawn new `pi --print --mode json --no-session`
  -> Pi startup + extension/package discovery
  -> provider request / model prompt prefill
  -> first thinking delta
  -> first user-visible text delta
```

The campaign must separate those phases before any architectural change. Do not implement persistent Pi/RPC yet. First establish whether Pi cold-start, prompt prefill, or PhantomBot's own preparation dominates TTFT.

## Non-goals

Do not:

- change model output, prompts, memory contents, retrieval ranking, tool behavior, fallback behavior, or channel behavior;
- replace `--print --no-session` with RPC yet;
- cache or trim history yet;
- change the Pi reasoning-intervention experiment;
- log prompt text, reasoning text, answer text, tool arguments/results, secrets, workspace paths, or memory contents;
- build a permanent observability subsystem.

Instrumentation must be opt-in and effectively zero-noise when disabled.

## Current execution path to preserve

At this revision, `src/orchestrator/turn.ts` owns persona loading, history, screening, retrieval, durable facts, daily recall, prompt construction, and `runWithFallback`.

The Pi harness renders the full history and current message into one payload, writes temp files, reloads persona vault state, builds per-turn routing env, then starts a fresh Pi process:

```ts
const proc = spawnInNewSession([this.config.bin, ...buildArgs(model)], {
  cwd: req.workingDir,
  env: childEnv,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});

yield* runHarnessProcess({
  proc,
  req,
  harnessId: this.id,
  parseEvent: parsePiEvent,
  activity: piActivity,
  buildDoneMeta: () => ({ harnessId: this.id, payloadBytes: totalBytes }),
  requireCompletion: true,
  // existing timeout options unchanged
});
```

Pi also emits raw lifecycle markers that are currently mostly ignored by `parsePiEvent`:

- startup `session` event;
- `agent_start`;
- `message_update` with `thinking_delta`;
- `message_update` with `text_delta`;
- `turn_end`.

These let us approximate Pi cold-start separately from provider/model prefill without logging chain-of-thought content.

## Required measurements

Use a monotonic clock (`performance.now()`) for durations. Every instrumented interactive turn should emit compact structured perf records keyed by the existing `turnId`.

Required fields:

| field | meaning |
| --- | --- |
| `turn_total_ms` | `runTurnBody` entry to successful `done` |
| `turn_prepare_ms` | `runTurnBody` entry to immediately before `runWithFallback` |
| `persona_load_ms` | persona file load |
| `history_load_ms` | recent-turn load |
| `screen_ms` | threat screening, or not-run |
| `retrieval_ms` | auto-retrieval |
| `durable_facts_ms` | durable-fact pull |
| `daily_recall_ms` | daily journal read |
| `prompt_build_ms` | system prompt + overlays construction |
| `pi_invoke_prepare_ms` | Pi harness entry to immediately before first spawn |
| `pi_spawn_call_ms` | synchronous `spawnInNewSession` duration |
| `pi_spawn_to_first_raw_ms` | spawn return to first parseable Pi stdout JSON event |
| `pi_first_raw_to_agent_start_ms` | first raw event to `agent_start`, when both exist |
| `pi_agent_start_to_first_model_delta_ms` | `agent_start` to first `thinking_delta` or `text_delta` |
| `pi_spawn_to_first_model_delta_ms` | spawn return to first model delta |
| `pi_spawn_to_first_text_ms` | spawn return to first `text_delta` |
| `turn_to_first_text_ms` | `runTurnBody` entry to first user-visible `text` chunk |
| `history_turns` | prior turns sent to Pi |
| `history_bytes` | UTF-8 bytes of history text only |
| `system_prompt_bytes` | UTF-8 bytes of assembled system prompt |
| `payload_bytes` | rendered Pi payload bytes |
| `user_message_bytes` | UTF-8 bytes of current user message |
| `model` | model ID only |
| `attempt` | process-attempt number |
| `attempt_kind` | e.g. `primary` or `coder` when swap retry logic applies |

Do not log conversation text. Prefer `turnId` as the correlation key. Conversation identifiers are unnecessary for the campaign.

## Opt-in switch

Use an environment gate:

```ts
export function perfTraceEnabled(): boolean {
  return process.env.PHANTOMBOT_PERF_TRACE === "1";
}
```

Normal operation with the variable unset must remain unchanged.

## Suggested helper

Keep this deliberately small and use the existing structured logger so its redaction choke-point still applies.

```ts
// src/lib/perfTrace.ts
import { log } from "./logger.ts";

export const perfNow = (): number => performance.now();

export const elapsedMs = (start: number, end = performance.now()): number =>
  Math.round((end - start) * 10) / 10;

export function perfTrace(
  msg: string,
  fields: Record<string, unknown>,
): void {
  if (process.env.PHANTOMBOT_PERF_TRACE !== "1") return;
  log.info(msg, fields);
}
```

Adapt to repo conventions if there is a cleaner equivalent. Do not add a second logging backend.

## Turn-layer instrumentation

Instrument `src/orchestrator/turn.ts` at the boundaries it already owns. Measure around existing calls without changing their order or error handling.

Illustrative shape:

```ts
async function* runTurnBody(
  input: TurnInput,
  turnId: string,
): AsyncGenerator<HarnessChunk> {
  const tTurn = perfNow();

  let t = perfNow();
  const persona = await loadPersona(input.agentDir);
  const personaLoadMs = elapsedMs(t);

  t = perfNow();
  const history = input.noHistory
    ? []
    : await input.memory.recentTurns(
        input.persona,
        input.conversation,
        input.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      );
  const historyLoadMs = elapsedMs(t);

  // Wrap existing screen / retrieve / pullFacts / buildDailyRecall calls
  // similarly. Preserve all current try/catch behavior.

  t = perfNow();
  const baseSystemPrompt = buildSystemPrompt(/* existing args */);
  // existing overlay construction remains unchanged
  const systemPrompt = /* existing final prompt */;
  const promptBuildMs = elapsedMs(t);

  const harnessStartAt = perfNow();
  let firstTextAt: number | undefined;

  for await (const chunk of runWithFallback(/* existing args */)) {
    if (chunk.type === "text" && firstTextAt === undefined) {
      firstTextAt = perfNow();
    }
    // existing accumulation / done handling unchanged
    yield chunk;
  }

  perfTrace("perf.turn", {
    turnId,
    turn_total_ms: elapsedMs(tTurn),
    turn_prepare_ms: elapsedMs(tTurn, harnessStartAt),
    persona_load_ms: personaLoadMs,
    history_load_ms: historyLoadMs,
    prompt_build_ms: promptBuildMs,
    history_turns: history.length,
    history_bytes: Buffer.byteLength(
      history.map((x) => x.text).join(""),
      "utf8",
    ),
    system_prompt_bytes: Buffer.byteLength(systemPrompt, "utf8"),
    user_message_bytes: Buffer.byteLength(input.userMessage, "utf8"),
    turn_to_first_text_ms:
      firstTextAt === undefined ? undefined : elapsedMs(tTurn, firstTextAt),
  });
}
```

The actual implementation may use one small per-turn accumulator rather than many locals. Preserve generator `finally` behavior and do not let perf logging break a turn.

## Pi-harness instrumentation

`src/harnesses/pi.ts` is where the critical cold-start split can be measured.

Boundaries:

```text
PiHarness.invoke entry
  -> payload/temp/routing/vault preparation complete
  -> spawn requested
  -> spawn returned
  -> first raw Pi JSON event
  -> agent_start
  -> first model delta (thinking_delta or text_delta)
  -> first text delta
  -> turn_end
```

### Spawn timing

Inside `runAttempt`:

```ts
const spawnRequestedAt = perfNow();
const proc = spawnInNewSession([this.config.bin, ...buildArgs(model)], {
  cwd: req.workingDir,
  env: childEnv,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const spawnReturnedAt = perfNow();
const spawnCallMs = elapsedMs(spawnRequestedAt, spawnReturnedAt);
```

Capture the outer Pi-invoke start before payload/temp/vault/routing preparation so `pi_invoke_prepare_ms` represents the actual work before spawn. If coder-swap retries occur, distinguish one-time outer preparation from per-attempt work instead of double-counting.

### Raw-event timing

Do not change `parsePiEvent` semantics. Wrap it for instrumentation:

```ts
let firstRawAt: number | undefined;
let agentStartAt: number | undefined;
let firstModelDeltaAt: number | undefined;
let firstTextDeltaAt: number | undefined;
let turnEndAt: number | undefined;

const timedParsePiEvent = (parsed: unknown): HarnessChunk | undefined => {
  const now = perfNow();

  if (firstRawAt === undefined) firstRawAt = now;

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    if (obj.type === "agent_start" && agentStartAt === undefined) {
      agentStartAt = now;
    }

    if (obj.type === "turn_end" && turnEndAt === undefined) {
      turnEndAt = now;
    }

    if (obj.type === "message_update") {
      const ame = obj.assistantMessageEvent;
      if (ame && typeof ame === "object") {
        const kind = (ame as Record<string, unknown>).type;
        if (
          firstModelDeltaAt === undefined &&
          (kind === "thinking_delta" || kind === "text_delta")
        ) {
          firstModelDeltaAt = now;
        }
        if (firstTextDeltaAt === undefined && kind === "text_delta") {
          firstTextDeltaAt = now;
        }
      }
    }
  }

  return parsePiEvent(parsed);
};
```

Then pass:

```ts
parseEvent: timedParsePiEvent,
```

The wrapper may inspect event type names only. Never log `delta`, `message`, raw tool args, partial results, or other event payloads.

### Per-attempt summary

Illustrative record:

```ts
perfTrace("perf.pi_attempt", {
  turnId: req.turnId,
  model,
  attempt,
  attempt_kind: attemptKind,
  payload_bytes: totalBytes,
  history_turns: req.history.length,
  pi_spawn_call_ms: spawnCallMs,
  pi_spawn_to_first_raw_ms:
    firstRawAt === undefined ? undefined : elapsedMs(spawnReturnedAt, firstRawAt),
  pi_first_raw_to_agent_start_ms:
    firstRawAt === undefined || agentStartAt === undefined
      ? undefined
      : elapsedMs(firstRawAt, agentStartAt),
  pi_agent_start_to_first_model_delta_ms:
    agentStartAt === undefined || firstModelDeltaAt === undefined
      ? undefined
      : elapsedMs(agentStartAt, firstModelDeltaAt),
  pi_spawn_to_first_model_delta_ms:
    firstModelDeltaAt === undefined
      ? undefined
      : elapsedMs(spawnReturnedAt, firstModelDeltaAt),
  pi_spawn_to_first_text_ms:
    firstTextDeltaAt === undefined
      ? undefined
      : elapsedMs(spawnReturnedAt, firstTextDeltaAt),
  pi_attempt_total_ms:
    turnEndAt === undefined
      ? undefined
      : elapsedMs(spawnReturnedAt, turnEndAt),
});
```

Be precise in interpretation:

- `spawn -> first raw event` is a cold-start proxy, not proof that every millisecond is Node/Pi initialization.
- `agent_start -> first model delta` includes provider/request overhead plus model prompt prefill and any provider-side setup.

## Correlation and concurrency

Use existing `turnId` as the join key. Do not use a process-global timer because sibling turns can overlap.

For coder-swap retries, emit one `perf.pi_attempt` per actual process spawn. The stable `turnId` plus `attempt` and `attempt_kind` must make retries unambiguous.

## Tests

Do not assert exact milliseconds.

Add focused tests for invariants:

1. no perf records when `PHANTOMBOT_PERF_TRACE` is unset;
2. records appear when enabled;
3. records contain only durations/counts/IDs and no prompt/history/message/reasoning/tool text;
4. the Pi event observer recognizes `session`, `agent_start`, `thinking_delta`, `text_delta`, and `turn_end` boundaries without altering `parsePiEvent` output;
5. simultaneous turn IDs do not mix timing state;
6. retries produce distinct attempt records.

Keep the helper/tests narrow; this is not a general telemetry framework.

## Real benchmark matrix

Run after tests pass, on the real Windows local setup with Qwen3.8-27B already resident in llama.cpp and the current OpenAI-compatible semantic retrieval enabled. Keep server/model/configuration unchanged across samples.

Use a deterministic short request such as `Reply with exactly OK.` so output length is not a variable. Do not use the reasoning-loop test for latency measurement.

### A. Fresh / tiny context

- empty/new conversation;
- short prompt;
- no deliberate tools;
- 5-10 measured turns.

Purpose: fixed startup floor.

### B. Medium context

- representative conversation with roughly 10-20 prior turns;
- same short prompt;
- no deliberate tools;
- 5-10 measured turns.

Purpose: measure context-size scaling.

### C. Long context

- close to a normally large conversation;
- same short prompt;
- no deliberate tools;
- 5-10 measured turns.

Purpose: expose repeated prompt-prefill cost.

Mark genuinely cold llama.cpp/server samples separately; do not mix them into warm medians.

## Analysis

For each class report median, p90, min, max for:

```text
turn_prepare_ms
pi_invoke_prepare_ms
pi_spawn_to_first_raw_ms
pi_agent_start_to_first_model_delta_ms
pi_spawn_to_first_model_delta_ms
pi_spawn_to_first_text_ms
turn_to_first_text_ms
```

Also tabulate `payload_bytes` against `pi_agent_start_to_first_model_delta_ms` and `turn_to_first_text_ms`.

Questions:

### Is Pi cold-start material?

Evidence: large, fairly constant `pi_spawn_to_first_raw_ms` across tiny/medium/long contexts.

If this is a major fraction of TTFT, a persistent `pi --mode rpc` prototype is justified.

### Is model prefill material?

Evidence: `pi_agent_start_to_first_model_delta_ms` grows with payload size while spawn/startup stays comparatively flat.

If this dominates, persistent Pi alone will not solve the delay. Next research should focus on session/history/prefix reuse and context ownership.

### Is PhantomBot preparation material?

Evidence: large `turn_prepare_ms`; then use its measured subcomponents rather than guessing. Retrieval is a candidate only if measured as such.

## Decision rules

Do not implement RPC in this campaign.

Classify warm TTFT as:

- **Pi startup dominated** -> persistent RPC prototype next;
- **prefill dominated** -> investigate history/session/prefix reuse first;
- **PhantomBot preparation dominated** -> optimize measured substage;
- **mixed** -> estimate recoverable seconds for each candidate before choosing complexity.

A persistent Pi architecture should be pursued because the gain is meaningful, not merely measurable. A reasonable local threshold is roughly >=20% of median warm TTFT or >=1 second recoverable from fresh Pi startup. Below that, prefer simpler fixes unless RPC also enables context reuse.

## Campaign deliverable

Commit instrumentation plus a result document containing:

- starting SHA and final SHA;
- machine/model/Pi versions;
- environment flag used;
- benchmark procedure;
- raw per-turn timing table with no private text;
- median/p90 summary by context class;
- dominant-latency conclusion;
- estimated maximum gain from removing fresh Pi startup;
- recommendation: keep current lifecycle, prototype persistent RPC, or investigate prefill/preparation first;
- files changed;
- confirmation that behavior/tests remain unchanged with tracing disabled.

Do not merge or open an upstream PR from this campaign. This is local performance research first.

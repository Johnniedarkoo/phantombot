# Cache-friendly prompt layout implementation handoff (historical)

Branch: `feature/cache-friendly-prompt-layout`

Base: `09324c015adc1d1d1062f40d6123582f32cd699a` from `perf/pi-ttft-instrumentation`

Design: `docs/cache-friendly-prompt-layout-design.md`

## What was implemented

The branch now contains the two architectural seams the implementation should use rather than duplicating formatting logic in each adapter:

- `src/persona/turnContext.ts`
  - `TURN_CONTEXT_SYSTEM_RULE`
  - `buildTurnContext()`
  - explicit volatile-context input types
- `src/harnesses/payload.ts`
  - `renderConversationPayload()`
  - canonical ordering: history -> turn context -> current user message
- `tests/cache-friendly-prompt-layout.test.ts`
  - basic ordering, legacy-absence, context-format, and authority-contract tests

The branch then wired these seams into production across the orchestrator and
harnesses. The follow-up canonicalization removed the temporary gate and the
legacy prompt construction; this handoff remains as historical implementation
context.

## Required integration

### 1. Extend the harness contract

In `src/harnesses/types.ts`, add an optional field:

```ts
/**
 * Volatile PhantomBot context for THIS turn. When present, adapters must place
 * it after canonical history and before the current user message.
 */
turnContext?: string;
```

Also update the top-level `HarnessRequest` comment so `systemPrompt` no longer claims to include retrieved memory/channel context once the new path is active.

### 2. Split stable system material from volatile context

Refactor `src/persona/builder.ts` so the cache-friendly path can build a stable/high-authority system prompt without embedding:

- durable facts
- retrieved memory
- daily recall
- display-only channel metadata / timestamp

Keep in system role:

- persona identity / BOOT
- persona persistent memory
- tools and PhantomBot tool instructions
- scheduling / MCP / notification / workspace / credential rules
- trusted-vs-untrusted security-perimeter selection
- system-level overlays and other instruction-bearing material
- `TURN_CONTEXT_SYSTEM_RULE`

Do not demote instruction-bearing overlays merely for cache purity.

A clean shape is:

```ts
buildStableSystemPrompt(persona, channelSecurityContext)
buildTurnContext({ durableFacts, retrievedMemory, dailyRecall, channel })
```

Backwards compatibility is useful while the experiment flag exists: either keep the old `buildSystemPrompt()` wrapper or make the old path explicit in `turn.ts`.

### 3. Wire the experimental path in `src/orchestrator/turn.ts`

Use temporary gate:

```text
PHANTOMBOT_CACHE_FRIENDLY_PROMPT=1
```

Flag OFF:
- use the exact old prompt construction and request shape
- prompt bytes/ordering must stay unchanged

Flag ON:
- build stable system prompt
- build volatile `turnContext`
- pass `turnContext` through `HarnessRequest`
- preserve retrieval, durable-fact, journal, threat-screen, overlay, persistence and fallback ordering exactly

The experiment changes placement only; it must not change what memory is retrieved or persisted.

### 4. Replace duplicated history rendering with `renderConversationPayload()`

#### Pi

`src/harnesses/pi.ts#renderPayload()` should delegate to the shared helper.

Desired semantics:

```ts
export function renderPayload(req: HarnessRequest): string {
  return renderConversationPayload(req);
}
```

This is the primary acceptance surface.

#### Claude

`src/harnesses/claude.ts#renderStdinPayload()` should use the same helper. Claude retains its native system-prompt channel.

#### Codex

Codex currently carries `systemPrompt` in stdin. Preserve that behavior, but build the user-side suffix via the shared helper:

```ts
const payload = renderConversationPayload(req);
return [req.systemPrompt.trim(), payload]
  .filter(Boolean)
  .join("\n\n");
```

Do not accidentally remove the Codex system prompt during this refactor.

### 5. Preserve tool-less/background callers

Many internal callers construct `HarnessRequest` without retrieved memory. `turnContext` is optional precisely so these paths remain valid.

Verify threat judge, durable-fact extraction, nightly, tick, degraded replies and fallback calls do not acquire new required fields.

## Tests to add/finish

Keep the existing helper tests and add integration coverage for:

1. feature flag OFF produces the legacy prompt byte-for-byte;
2. feature flag ON keeps volatile memory out of the system prompt;
3. feature flag ON preserves retrieved memory, durable facts, daily recall and channel metadata in `turnContext`;
4. Pi payload order is history -> turnContext -> current user;
5. Claude payload order matches the same contract;
6. Codex still receives its system prompt and places volatile context after history;
7. trusted/untrusted security-perimeter selection remains system-level;
8. instruction-bearing overlays remain system-level;
9. no retrieved/daily memory is silently dropped when values are empty/undefined;
10. consecutive synthetic turns share the intended stable serialized prefix through old history;
11. tool-less/background callers compile and behave as before;
12. cache-friendly flag absent/off causes no new perf/log output.

Do not assert llama.cpp KV internals in unit tests. Assert the serialized ordering contract that makes reuse possible.

## Validation

Run the repository contract from root `AGENTS.md`, including at minimum:

```text
bun tsc --noEmit
bun run build
bun test
```

The branch already carries the TTFT instrumentation. Keep it intact for the A/B; do not redesign it.

Known Windows baseline failures must be classified rather than fixed opportunistically.

## Performance acceptance

After semantic tests pass, use the existing disposable benchmark setup from `docs/pi-ttft-instrumentation-results.md`.

Run sequential same-conversation A/B:

```text
A: PHANTOMBOT_CACHE_FRIENDLY_PROMPT unset/off
B: PHANTOMBOT_CACHE_FRIENDLY_PROMPT=1
```

Keep the same resident llama.cpp server, model, embedding provider, retrieval settings and reasoning-intervention configuration.

The first request in each run is warm-up. Compare subsequent turns primarily on:

- `pi_agent_start_to_first_model_delta_ms`
- `pi_spawn_to_first_model_delta_ms`
- `pi_spawn_to_first_text_ms`
- `turn_to_first_text_ms`

The expected mechanism is common-prefix reuse. A successful result should save seconds to tens of seconds on warm consecutive turns while preserving PhantomBot memory semantics.

## Do not do in this branch

Do not combine this with:

- persistent Pi / RPC
- Pi SDK embedding
- history-window changes
- prompt trimming
- explicit llama.cpp slot management
- alternate model/server configuration
- changes to the reasoning-intervention experiment

Those would destroy causal attribution.

## Deliverable

Finish the integration, tests and A/B on this branch only. Commit implementation and benchmark results separately. Do not open a PR until the result is reviewed.

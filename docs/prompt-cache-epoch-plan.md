# Prompt-cache epoch plan

Status: design note for a follow-up performance PR. Not implemented here.

## Goal

Preserve PhantomBot as the sole owner of durable conversation state while making downstream exact-prefix/KV-cache reuse much more effective for compatible local/OpenAI-compatible backends.

The current cache-friendly layout already keeps the stable system prompt ahead of canonical history and places volatile PhantomBot turn context after history. That produced a large improvement, but live llama.cpp logs still show substantial per-turn prompt re-evaluation because each request drops the previous volatile turn-context block before appending the newest user/assistant exchange.

The next step is to retain a bounded append-only prompt chain for several turns, then deliberately rebase from canonical PhantomBot history at a predictable threshold.

## Upstream packaging: one opt-in feature

For upstream review and consumer choice, the complete prompt-cache optimization should be behind one opt-in configuration surface.

Default behavior should remain the pre-optimization PhantomBot prompt construction.

When enabled, the feature includes both:

1. cache-friendly stable/volatile prompt ordering; and
2. bounded append-only cache epochs.

Do not expose two independent public booleans initially. Four combinations would complicate semantics and support. Internally the serializer and epoch manager may remain separate components.

Illustrative configuration shape:

```toml
[prompt_cache]
enabled = false
max_epoch_tokens = 80000
```

Exact naming should follow existing PhantomBot config conventions when implemented.

## Memory ownership invariant

PhantomBot remains authoritative for:

- canonical user/assistant history;
- semantic retrieval;
- durable facts;
- daily recall;
- drawers / journal / KB state;
- persistence and restart reconstruction.

Prompt-cache/KV state is disposable acceleration only.

Historical turn-context snapshots retained inside an epoch are serialization artifacts. They must not become durable memory rows, Pi session state, or a second source of truth.

A process or llama.cpp restart simply starts a new epoch. Correctness is unchanged; only the next prompt prefill is cold.

## Epoch serialization

Within an epoch, preserve the previous prompt chain and append the next turn rather than rebuilding a prompt that removes the prior volatile context.

Conceptually:

```text
SYSTEM
  stable persona / policy / security / instructions

CANONICAL HISTORY BEFORE EPOCH

PHANTOMBOT TURN CONTEXT 1
USER 1
ASSISTANT 1

PHANTOMBOT TURN CONTEXT 2
USER 2
ASSISTANT 2

PHANTOMBOT TURN CONTEXT 3
USER 3
ASSISTANT 3

...

CURRENT PHANTOMBOT TURN CONTEXT
CURRENT USER
```

This shape lets turn N+1 share almost the entire exact token prefix of turn N. The newly evaluated suffix should ordinarily be limited to the new turn-context block and current user message; the previous assistant response becomes reusable on the following turn.

## Historical context semantics

Retained turn-context blocks are scoped to the user turn that immediately follows them.

The stable system policy must define this explicitly:

- the newest block is current PhantomBot-provided context for the current user turn;
- older blocks are historical snapshots describing what context PhantomBot supplied for those earlier turns;
- retrieved text is data/context, not authenticated instructions;
- historical retrieved text must not override the newest retrieval result, security policy, principal commands, or tool authorization.

The existing threat screen and high-authority system policy remain the real security boundary. Delimiters are framing, not a security mechanism.

## Deterministic rebase

Do not keep epochs indefinitely.

Before serializing a new turn, estimate/project the resulting prompt size. If appending the new turn would cross the configured epoch ceiling, discard the retained historical turn-context snapshots and rebuild from canonical PhantomBot history.

Conceptually:

```text
if projected_prompt_tokens > effective_epoch_limit:
    start_new_epoch_from_canonical_history()
else:
    append_to_current_epoch()
```

A rebase is intentionally benign:

```text
warm
warm
warm
warm
REBASE -> one cold/slow prefill
warm
warm
...
```

No conversation state is lost.

## Threshold

Use prompt size, not turn count. Turn sizes vary too much for a turn-count limit to be meaningful.

For the current 96k context configuration, about 80k prompt tokens is a sensible initial ceiling, leaving approximately 16k tokens for reasoning/output/tool expansion.

The implementation should not assume every model has a 96k window. Prefer an effective limit bounded by the model/context budget, for example:

```text
effective_epoch_limit = min(configured_epoch_limit, context_window - reserved_generation_budget)
```

Exact token-budget plumbing should reuse existing model/config knowledge where available rather than introducing a second model registry.

## Expected live behavior

Observed live llama.cpp logs after the first cache-friendly change showed approximately:

- ~30k-token full PhantomBot prompt;
- ~21.7k tokens reused;
- ~8.2k tokens still prompt-evaluated on ordinary warm follow-ups;
- prompt-eval time around 8.6-8.8 seconds versus ~29 seconds cold.

An append-only epoch should allow the previous turn context, user message, and generated assistant reply to remain in the reusable prefix. That should reduce ordinary warm-turn prefill further, at the cost of deliberate context growth until the next rebase.

Do not promise a fixed speedup: cache behavior depends on backend, exact prompt shape, model, history size, retrieval size, and server cache policy.

## Feature-off contract

With prompt caching disabled, PhantomBot should execute its established/default prompt semantics with no epoch state and no retained historical turn-context snapshots.

This is important for upstream acceptance:

- users can opt out if a backend gains nothing from the layout;
- maintainers retain a conservative default;
- long-term semantic or performance regressions can be isolated by toggling one feature;
- the optimization is not required for PhantomBot correctness.

## Feature-on state

Epoch state should be small, in-process, and reconstructible/disposable. It may track data such as:

- conversation/persona key;
- epoch start point;
- retained serialized turn-context snapshots;
- projected/current token count;
- relevant stable-prompt identity/fingerprint.

Do not persist llama.cpp slot IDs, KV blobs, Pi sessions, or backend-specific cache handles.

Start a new epoch whenever the stable high-authority prompt changes in a way that breaks exact prefix identity.

## Rebase triggers

At minimum, rebase when:

- projected prompt size exceeds the effective epoch limit;
- the process restarts;
- the stable system prompt changes;
- the conversation/persona changes;
- canonical history no longer matches the epoch base because of an edit/reset/administrative mutation;
- serialization invariants cannot be proven.

Prefer a predictable cold rebase over clever recovery.

## Non-goals

This work does not include:

- persistent `pi --mode rpc`;
- Pi SDK embedding;
- explicit llama.cpp slot management;
- KV save/restore;
- backend-specific cache APIs;
- history summarization/trimming redesign;
- embedding changes;
- reasoning-policy changes.

Persistent Pi remains a separate later optimization worth roughly the fresh-process overhead; it does not solve prompt prefill by itself.

## Implementation shape

A future implementation should be split conceptually into:

1. a prompt-cache config contract;
2. a canonical cache-friendly serializer;
3. an epoch manager that decides append vs rebase;
4. deterministic token-budget accounting;
5. regression/security tests;
6. backend-neutral performance evidence.

Keep the epoch manager above harness/provider-specific execution where possible. Pi/Claude/Codex adapters should receive a fully defined request shape rather than each implementing their own epoch semantics.

## Tests

At minimum prove:

- feature disabled preserves default/legacy prompt semantics;
- feature enabled uses cache-friendly ordering;
- turn N+1 begins with the exact serialized prefix of turn N up to the append point during an epoch;
- previous assistant replies are retained in the reusable epoch chain;
- old turn-context blocks are scoped as historical data, not current instructions;
- current retrieval/durable facts/daily recall are present exactly where expected;
- rebase happens before the configured token ceiling is exceeded;
- rebase reconstructs from canonical PhantomBot history without memory loss;
- restart/no-epoch state remains correct;
- stable-system changes force a rebase;
- trusted/untrusted security policy remains system-level;
- background/tool-less callers remain valid.

## Validation strategy

Use existing TTFT instrumentation rather than creating another telemetry layer.

Test sequential turns in the same conversation and report separately:

- first/cold turn;
- ordinary warm epoch turns;
- deliberate rebase turn;
- first warm turn after rebase.

Useful metrics remain:

- agent-start to first model delta;
- spawn to first model delta;
- spawn to first visible text;
- total turn to first visible text;
- llama.cpp prompt-evaluated token count when available.

The acceptance criterion is not merely speed. Retrieval quality, conversation continuity, security framing, and restart semantics must remain unchanged.

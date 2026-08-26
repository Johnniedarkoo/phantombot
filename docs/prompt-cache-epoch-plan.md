# Prompt-cache ordering and bounded epochs

Status: implemented as the opt-in `[prompt_cache]` feature.

## Purpose

PhantomBot owns canonical conversation history, retrieval, durable facts, daily
recall, persona memory, security policy, and restart reconstruction. The prompt
cache is only disposable acceleration. A process restart or a backend cache
miss must affect latency, never correctness or recoverability.

The feature is disabled by default. When enabled, it combines two behaviors
behind one setting:

1. high-authority system material is kept stable and volatile PhantomBot turn
   context is placed after canonical history; and
2. completed turns are retained in a bounded, in-process append-only epoch so
   the next request can reuse the exact serialized prefix.

```toml
[prompt_cache]
enabled = false
max_epoch_tokens = 80000
```

The equivalent environment overrides are
`PHANTOMBOT_PROMPT_CACHE_ENABLED` and
`PHANTOMBOT_PROMPT_CACHE_MAX_EPOCH_TOKENS`.

## Serialization

With the feature enabled, the shared harness payload renderer produces:

```text
stable system prompt
canonical history before the epoch
turn-context 1
user 1
previous assistant response 1
turn-context 2
user 2
previous assistant response 2
current turn-context
current user message
```

The orchestrator builds this request shape once. Pi, Claude, and Codex receive
the same `HarnessRequest` fields; they do not implement independent epoch
logic. With the feature disabled, `turnContext` and `epochTurns` are absent,
and the established upstream payload is rendered unchanged.

Each context block describes the user message immediately following it. The
stable system rule identifies the newest block as current context and older
blocks as historical snapshots. Retrieved text remains data, not an
authenticated instruction, and historical text cannot override current
principal instructions, retrieval, security policy, tool authorization, or
stable system rules. Delimiters are framing only.

## Ownership and lifecycle

`PromptCacheEpochManager` lives above the harnesses in the orchestrator. Its
state is keyed by persona and conversation and contains only:

- the stable-system fingerprint;
- canonical history observed at epoch start and an in-process canonical
  expectation used to detect edits;
- serialized context/user/assistant triples; and
- a small active-turn marker.

No state is written to SQLite, persona files, Pi sessions, llama.cpp slots,
KV blobs, or backend-specific handles. The state is recreated empty after a
process restart. A successful turn is added only after PhantomBot persists its
canonical user/assistant pair. A failed turn is never added.

Concurrent turns for the same key invalidate the previous in-process epoch;
the next turn safely rebuilds from the memory store. This favors a predictable
rebase over making an ordering assumption about completion races.

## Rebase rules

Before a request is rendered, the manager compares the current canonical
history and full system prompt identity with the epoch state. It starts a new
epoch when:

- the projected prompt exceeds `max_epoch_tokens`;
- the process has no prior in-memory state;
- the persona or conversation key changes;
- the high-authority system prompt changes, including instruction-bearing
  overlays;
- canonical history no longer matches the expected persisted tail; or
- an active concurrent turn makes the old ordering unverifiable.

Rebasing discards only the serialized epoch snapshots. It rebuilds from the
canonical history just read from PhantomBot's memory store. The expected
sequence is therefore several warm turns, one intentionally cold rebase turn,
then more warm turns.

If the canonical prompt plus the new turn is itself larger than the configured
epoch ceiling, the request is still sent from canonical history for correctness
but is not retained in an epoch. The setting is an optimization budget, not a
reason to reject a conversation.

## Token budget

PhantomBot currently has no shared exact tokenizer or model-context registry
for all supported harnesses. The manager therefore uses a deterministic
conservative UTF-16 code-unit estimate over the serialized system and payload
strings. It deliberately overestimates non-ASCII text and is a prompt-budget
estimate, not a claim about any particular model tokenizer. `max_epoch_tokens` should be chosen below the available
prompt budget for the configured harness/model; backend-specific cache or
context settings are outside this feature.

No llama.cpp flags, cache settings, slot controls, persistence, or model
configuration are required. Backends that do not reuse exact prefixes still
receive the same complete, correctly ordered conversation.

## Scope boundaries

This feature deliberately does not add persistent Pi/RPC sessions, history
trimming or summarization, selective context dropping, KV save/restore, SSD
storage, embedding changes, reasoning changes, or a second memory store. A
future optimization must preserve PhantomBot's canonical durable-state
ownership and keep cache state disposable.

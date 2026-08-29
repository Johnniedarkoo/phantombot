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
   the next PhantomBot payload can retain an exact serialized prefix.

```toml
[prompt_cache]
enabled = false
max_epoch_bytes = 80000
```

The equivalent environment overrides are
`PHANTOMBOT_PROMPT_CACHE_ENABLED` and
`PHANTOMBOT_PROMPT_CACHE_MAX_EPOCH_BYTES`.

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

There are two separate prefix claims:

1. **PhantomBot serialized payload prefix:** within an epoch, payload N is an
   exact textual prefix of payload N+1. The historical context and user
   message that previously broke the prefix are retained identically.
2. **Backend/model KV prefix:** Pi, Claude, and Codex are stateless CLI
   harnesses that submit this rendered history as a flattened user-side
   payload. On the immediately following request, the actual model-input LCP
   can extend through the previous context and user message, but the
   chat-template transition to the generated assistant response differs. The
   immediately previous generated assistant response is therefore not
   guaranteed to be reusable on that next request. Its wrapped representation
   is present in the next request and can become part of the reusable prefix
   on the request after that.

The epoch tests prove the first property only; they do not claim full backend
KV reuse of the immediately previous assistant generation. Assistant responses
remain in epoch history because they are required for conversation semantics
and become part of the stable serialized prefix on later turns.

## Ownership and lifecycle

`PromptCacheEpochManager` lives above the harnesses in the orchestrator. Its
state is keyed by persona and conversation and contains only:

- the stable-system fingerprint;
- the explicit trust bit and effective security-surface fingerprint;
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

Security boundaries are explicit cache boundaries as well. A trusted/untrusted
transition rebases from canonical history even when the rendered system prompt
happens to be unchanged. A held untrusted request discards the warm epoch before
the hold is returned, because held requests stop before cache preparation. The
manager also discards all persona states for a conversation when its active
persona changes, so A → B → A cannot resume A's earlier epoch; other
persona/conversation keys remain independent for normal multi-persona service.
Effective screening and tool-surface changes use the same explicit security
boundary. Channel authentication, allowlists, harness/MCP configuration, and
other security settings are loaded by the long-lived process and their existing
settings flows require a restart. Since epoch state is process-local, a restart
already clears it; persona/policy prompt edits remain additionally covered by
the full system fingerprint.

## Rebase rules

Before a request is rendered, the manager compares the current canonical
history and full system prompt identity with the epoch state. It starts a new
epoch when:

- the projected prompt exceeds `max_epoch_bytes`;
- the process has no prior in-memory state;
- the persona or conversation key changes;
- the high-authority system prompt changes, including instruction-bearing
  overlays;
- canonical history no longer matches the expected persisted tail;
- explicit trust, persona, or effective security-surface state changes; or
- an active concurrent turn makes the old ordering unverifiable.

Rebasing discards only the serialized epoch snapshots. It rebuilds from the
canonical history just read from PhantomBot's memory store. The expected
sequence is therefore several warm turns, one intentionally cold rebase turn,
then more warm turns.

If the canonical prompt plus the new turn is itself larger than the configured
epoch ceiling, the request is still sent from canonical history for correctness
but is not retained in an epoch. The setting is an optimization budget, not a
reason to reject a conversation.

## Rendered byte budget

`max_epoch_bytes` measures the UTF-8 byte length of the PhantomBot-rendered
system prompt and conversation payload, including their separator when both
are present. It is not an exact model-token count. Harness, chat-template, and
tool tokens may exist outside this measurement, so the setting is an
optimization bound, not a guarantee about the backend's usable context.

Operators should choose the value conservatively for their configured model
and harness. The shipped `80000` value is a conservative local starting
point; we will tune it from benchmark evidence later. PhantomBot does not
infer a token limit from a hardcoded bytes-per-token ratio and does not
introduce a tokenizer or backend/model registry.

No llama.cpp flags, cache settings, slot controls, persistence, or model
configuration are required. Backends that do not reuse exact prefixes still
receive the same complete, correctly ordered conversation.

## Scope boundaries

This feature deliberately does not add persistent Pi/RPC sessions, history
trimming or summarization, selective context dropping, KV save/restore, SSD
storage, embedding changes, reasoning changes, or a second memory store. A
future optimization must preserve PhantomBot's canonical durable-state
ownership and keep cache state disposable.

## Operational telemetry

When `[prompt_cache].enabled = true`, the orchestrator emits one INFO JSON
line per eligible turn with `msg: "prompt_cache.epoch"`. The safe fields are
`event`, `persona`, `conversation`, `base_history_turns`, `epoch_turns`,
`prompt_bytes`, `max_epoch_bytes`, and `retain_epoch`. `prompt_bytes` is the
same rendered UTF-8 measurement used by the epoch ceiling. Budget rebases also
include `projected_epoch_bytes`, the pre-rebase projection.

`event` is one of `new`, `append`, `rebase`, `bypass`, or `invalidate`. `new` carries
`reason: "no_state"`; `rebase` carries `rebase_reason`; and `bypass` carries
`bypass_reason`. `invalidate` carries `invalidation_reason`. Reasons currently
emitted are `no_state`, `budget`,
`system_changed`, `history_changed`, `concurrent_turn`, `oversized_base`, and
`no_history`, plus the explicit security reasons `trust_changed`,
`persona_changed`, `threat_hold`, and `security_changed`. When multiple
invalidation conditions are true, the deterministic precedence is
`persona_changed`, `no_state`, `concurrent_turn`, `trust_changed`,
`security_changed`, `system_changed`, `history_changed`, then `budget`; a
request that remains over the ceiling after rebasing is reported as
`bypass/oversized_base`.

These are operational measurements only. No prompt, user or assistant text,
retrieved memory, durable fact, daily recall, system/persona content, tool
argument, or reversible content hash is logged. Telemetry does not become cache
state and is not persisted as conversation data.

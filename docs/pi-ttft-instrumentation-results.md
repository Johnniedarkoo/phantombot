# Pi TTFT instrumentation campaign results

Date: 2026-08-26

This document records the bounded instrumentation campaign described in
[the campaign design](pi-ttft-instrumentation-campaign.md). It reports timing
boundaries only; prompts, history contents, answers, reasoning, tool data, and
secrets were not recorded.

## Revisions and files

- Campaign branch starting point: `017d62404c1647e25195d415ce69d1be12ac81f9`
- Underlying OpenAI-compatible embeddings head: `b14c80cf98b9dc62a0a153c9a66ea2c58ad3930d`
- Instrumentation commit: `545e83a1da1e7d1035548b9583629b97fcf69777`
- Instrumentation correction: `3557ff1` (measures full attempt finalization)
- Final commit: the result-document commit at the branch tip; exact SHA is
  reported in the campaign handoff because the commit hash cannot be embedded
  in the bytes that determine that same hash

Files changed by the implementation:

- `src/lib/perfTrace.ts`
- `src/orchestrator/turn.ts`
- `src/harnesses/pi.ts`
- `tests/perf-instrumentation.test.ts`
- `tests/fixtures/fake-pi-perf.cmd`
- `docs/pi-ttft-instrumentation-results.md`

The instrumentation is opt-in with `PHANTOMBOT_PERF_TRACE=1`. It uses the
existing structured logger and monotonic `performance.now()` timing. With the
variable unset, the instrumentation does not emit records or alter turn
behavior.

## Environment and isolation

- Pi: 0.84.2
- Provider/model: `localllm/qwen3.8-27b`
- Retrieval: enabled, OpenAI-compatible embeddings using
  `Qwen3-Embedding-0.6B` (1024 dimensions)
- LocalLLM/llama.cpp: resident warm model; no model or provider settings were
  changed
- `pi-reasoning-intervention`: left in its existing OBSERVE configuration
- No persistent Pi, RPC, caching, history trimming, or other optimization was
  implemented

The active PhantomBot config, persona directory, vault data, and memory
database were copied to a disposable benchmark snapshot. The measured runner
used that snapshot through environment overrides and the trusted channel turn
path. The live persona and live memory database were not modified.

The deterministic request asked for an exact short response and used no
deliberate tools. Six unmeasured medium seed turns created 12 prior messages
in the disposable database. The long class used a copied representative large
conversation; PhantomBot's normal history window supplied 30 history turns to
Pi. Each measured class used five sequential warm samples.

One tiny sample overlapped a one-off scheduled PhantomBot task and was excluded
before calculating results. It is not included in the counts below. The other
15 samples completed successfully. No cold model/server sample was included.

## Raw timing data

All timing values are milliseconds. `payload` is the Pi request payload byte
count. The raw table contains only perf summary fields.

| class | sample | prep | invoke prep | spawn→raw | agent→model | spawn→model | spawn→text | turn→text | payload | history |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| tiny | 01 | 14.3 | 23.9 | 3058.3 | 21794.8 | 24924.4 | 35212.3 | 35259.4 | 40945 | 0 |
| tiny | 03 | 79.5 | 22.0 | 3012.6 | 21946.7 | 25023.8 | 32450.1 | 32560.8 | 42208 | 0 |
| tiny | 04 | 76.4 | 21.4 | 3044.0 | 22298.6 | 25410.2 | 28041.9 | 28148.8 | 42208 | 0 |
| tiny | 05 | 73.5 | 21.5 | 2956.0 | 22505.3 | 25530.3 | 31904.8 | 32009.0 | 42208 | 0 |
| tiny | 06 | 76.8 | 26.8 | 3090.2 | 41615.5 | 44771.5 | 55991.8 | 56104.9 | 42208 | 0 |
| medium | 01 | 76.2 | 24.1 | 3212.7 | 60589.5 | 63868.3 | 72429.4 | 72538.8 | 42621 | 12 |
| medium | 02 | 75.3 | 22.1 | 3099.9 | 111107.2 | 114274.5 | 117585.3 | 117692.0 | 42690 | 14 |
| medium | 03 | 86.1 | 25.9 | 3400.9 | 60499.0 | 63971.9 | 76022.6 | 76144.7 | 42759 | 16 |
| medium | 04 | 83.6 | 26.1 | 3567.6 | 67892.2 | 71529.4 | 83262.6 | 83382.6 | 42828 | 18 |
| medium | 05 | 85.1 | 26.3 | 3284.4 | 65531.5 | 68886.9 | 71847.6 | 71969.4 | 42897 | 20 |
| long | 01 | 92.5 | 36.2 | 3456.4 | 36680.4 | 40209.5 | 77007.0 | 77147.1 | 72396 | 30 |
| long | 02 | 82.9 | 27.3 | 3288.9 | 76851.4 | 80233.4 | 257149.1 | 257270.0 | 72369 | 30 |
| long | 03 | 153.6 | 28.5 | 3207.4 | 30515.9 | 33794.3 | 98915.6 | 99107.8 | 72617 | 30 |
| long | 04 | 117.3 | 27.0 | 3070.5 | 30447.9 | 33587.9 | 102177.3 | 102331.1 | 72499 | 30 |
| long | 05 | 119.3 | 26.9 | 3072.4 | 30177.9 | 33319.1 | 131658.8 | 131814.8 | 71879 | 30 |

## Summary

Values are median / p90 / minimum / maximum, in milliseconds. With five
samples, p90 is the largest observed sample under the campaign's discrete
percentile convention.

| class | metric | median | p90 | min | max |
|---|---|---:|---:|---:|---:|
| tiny | turn_prepare_ms | 76.4 | 79.5 | 14.3 | 79.5 |
| tiny | pi_invoke_prepare_ms | 22.0 | 26.8 | 21.4 | 26.8 |
| tiny | pi_spawn_to_first_raw_ms | 3044.0 | 3090.2 | 2956.0 | 3090.2 |
| tiny | pi_agent_start_to_first_model_delta_ms | 22298.6 | 41615.5 | 21794.8 | 41615.5 |
| tiny | pi_spawn_to_first_model_delta_ms | 25410.2 | 44771.5 | 24924.4 | 44771.5 |
| tiny | pi_spawn_to_first_text_ms | 32450.1 | 55991.8 | 28041.9 | 55991.8 |
| tiny | turn_to_first_text_ms | 32560.8 | 56104.9 | 28148.8 | 56104.9 |
| medium | turn_prepare_ms | 83.6 | 86.1 | 75.3 | 86.1 |
| medium | pi_invoke_prepare_ms | 25.9 | 26.3 | 22.1 | 26.3 |
| medium | pi_spawn_to_first_raw_ms | 3284.4 | 3567.6 | 3099.9 | 3567.6 |
| medium | pi_agent_start_to_first_model_delta_ms | 65531.5 | 111107.2 | 60499.0 | 111107.2 |
| medium | pi_spawn_to_first_model_delta_ms | 68886.9 | 114274.5 | 63868.3 | 114274.5 |
| medium | pi_spawn_to_first_text_ms | 76022.6 | 117585.3 | 71847.6 | 117585.3 |
| medium | turn_to_first_text_ms | 76144.7 | 117692.0 | 71969.4 | 117692.0 |
| long | turn_prepare_ms | 117.3 | 153.6 | 82.9 | 153.6 |
| long | pi_invoke_prepare_ms | 27.3 | 36.2 | 26.9 | 36.2 |
| long | pi_spawn_to_first_raw_ms | 3207.4 | 3456.4 | 3070.5 | 3456.4 |
| long | pi_agent_start_to_first_model_delta_ms | 30515.9 | 76851.4 | 30177.9 | 76851.4 |
| long | pi_spawn_to_first_model_delta_ms | 33794.3 | 80233.4 | 33319.1 | 80233.4 |
| long | pi_spawn_to_first_text_ms | 102177.3 | 257149.1 | 77007.0 | 257149.1 |
| long | turn_to_first_text_ms | 102331.1 | 257270.0 | 77147.1 | 257270.0 |

## Interpretation

### Dominant component

PhantomBot turn preparation is not the dominant bottleneck. Preparation stayed
at 76.4 ms, 83.6 ms, and 117.3 ms median for tiny, medium, and long contexts.
Retrieval was the largest preparation substage but remained only about 70–146
ms; prompt construction was about 1–3 ms.

The dominant measured region is after `agent_start`: provider/request/model
work and the delay before usable visible text. The first model delta alone was
about 22.3 s tiny, 65.5 s medium, and 30.5 s long at the median, with large
warm variance. The post-model-delta path to first visible text was also large,
especially in the long class.

`pi_spawn_to_first_raw_ms` was comparatively flat at roughly 3.0–3.3 s. This
is a fresh-Pi cold-start proxy, not a claim that the entire interval is Node
startup; it can include Pi initialization and extension/runtime setup.

### Payload comparison

The median payloads were 42,208 bytes for tiny, 42,759 bytes for medium, and
72,396 bytes for long. The corresponding median
`pi_agent_start_to_first_model_delta_ms` values were 22,298.6 ms, 65,531.5 ms,
and 30,515.9 ms. The samples therefore do not show a clean monotonic
payload-to-prefill slope: medium had almost the same payload size as tiny but
much higher model-delta latency, while long had the largest payload but a lower
median than medium.

This boundary includes provider/request overhead and model scheduling or
generation behavior, not pure prompt prefill. A follow-up should isolate those
factors before attributing the whole interval to prefill. The visible-text
boundary is even less payload-diagnostic because output/reasoning duration is
included.

### Fresh-process opportunity

Eliminating the fresh-Pi startup proxy would recover approximately 3.0–3.3 s
per ordinary turn in this environment. Relative to median warm
`turn_to_first_text_ms`, that is roughly 9% for tiny, 4% for medium, and 3%
for long. It is below a 20% improvement, but it exceeds the campaign's
one-second decision threshold. A persistent lifecycle is therefore worth a
bounded prototype, but it is not expected to remove the dominant model/provider
and first-visible-text delay by itself.

## Recommendation for the next campaign

Prototype a narrow persistent `pi --mode rpc` path, retaining the current
per-turn path as fallback. Measure two effects separately:

1. recovery of the approximately 3-second fixed fresh-process cost; and
2. whether a persistent session enables history/session/prefix reuse that
   changes `agent_start` to first model delta.

Do not treat this result as evidence to implement prompt caching or history
changes yet. The next campaign should keep those optimizations separate from
the RPC lifecycle measurement and should preserve the current provider,
embedding, and reasoning-intervention configuration.

## Validation

- Focused instrumentation tests: 6 passed, 0 failed
- `bun tsc --noEmit`: passed
- `bun run build`: passed
- `bun test`: failed on known Windows baseline issues, including the existing
  Unix `.sh` fake-Pi process fixtures and unrelated filesystem/process/MCP/vault
  permission failures. The focused new instrumentation suite passed; no new
  instrumentation-specific failure was observed.

# Cache-Friendly Prompt Layout Results

Date: 2026-08-26

## Provenance

- Starting branch head: `4226e21f0af1d0871ac875019402aa1a077c1121`
- Implementation commit: `ef2a8e3` (`integrate cache-friendly prompt layout`)
- Base: `09324c015adc1d1d1062f40d6123582f32cd699a`
- Branch: `feature/cache-friendly-prompt-layout`

The implementation keeps PhantomBot authoritative for history, retrieval, durable facts, daily recall, and persistence. The llama.cpp prompt/KV state remains disposable. The feature gate is `PHANTOMBOT_CACHE_FRIENDLY_PROMPT=1`; the off path retains the legacy composition.

## Benchmark method

The benchmark used one resident llama.cpp router and the same local `qwen3.8-27b` model for both variants. The embedding provider and model, retrieval settings, reasoning settings, history size, and disposable synthetic persona were held constant. Each variant used a fresh disposable database snapshot containing a representative 30-turn history, then ran six short deterministic turns sequentially in the same conversation. The turns were trusted channel calls with no deliberate tools and each expected the exact reply `OK`.

The first turn for each variant is reported as warm-up. It establishes the initial prefix and is not included in the warm-turn medians.

## Measurements

Times are milliseconds. Payload and system columns are serialized byte counts.

| Variant | Turn | Phase | Agent → model delta | Spawn → model delta | Spawn → first text | Turn → first text | Payload | System |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A (flag off) | 1 | warm-up | 44699.2 | 47884.3 | 49308.3 | 49450.9 | 27511 | 24209 |
| A | 2 | warm | 45376.7 | 48591.8 | 49353.5 | 49644.9 | 27350 | 24179 |
| A | 3 | warm | 45718.7 | 48944.4 | 50805.2 | 51086.9 | 27184 | 24144 |
| A | 4 | warm | 45926.2 | 49142.4 | 52884.6 | 53167.6 | 27087 | 24178 |
| A | 5 | warm | 46003.1 | 49389.0 | 50209.9 | 50491.8 | 26954 | 24176 |
| A | 6 | warm | 46094.9 | 49448.3 | 50582.2 | 50869.3 | 26796 | 24149 |
| B (flag on) | 1 | warm-up | 45914.6 | 49251.2 | 51695.9 | 51820.8 | 28091 | 22772 |
| B | 2 | warm | 2521.9 | 5847.0 | 8991.3 | 9288.1 | 27930 | 22772 |
| B | 3 | warm | 2573.9 | 5862.6 | 10300.0 | 10391.6 | 27764 | 22772 |
| B | 4 | warm | 2412.7 | 5675.9 | 9301.0 | 9585.6 | 27667 | 22772 |
| B | 5 | warm | 2347.9 | 5626.9 | 6484.8 | 6569.2 | 27534 | 22772 |
| B | 6 | warm | 2424.3 | 5714.3 | 7377.6 | 7659.5 | 27376 | 22772 |

Warm-turn medians, turns 2–6:

| Metric | A | B | Reduction |
| --- | ---: | ---: | ---: |
| Agent → model delta | 45926.2 | 2424.3 | 94.72% |
| Spawn → model delta | 49142.4 | 5714.3 | 88.38% |
| Spawn → first text | 50582.2 | 8991.3 | 82.22% |
| Turn → first text | 50869.3 | 9288.1 | 81.75% |

The B system prompt stayed at 22772 bytes across all six turns, while the legacy system prompt varied as volatile context changed. The canonical suffix still changed per turn and retained the retrieved context, facts, daily recall, channel metadata, and current user message.

## Semantic and regression result

All twelve benchmark turns returned the expected `OK`. Retrieval and daily recall remained enabled, and the focused cache-layout suite passed all 9 tests (60 assertions). Those tests cover legacy flag-off layout, stable/volatile separation, retained facts/retrieval/recall, history → turn context → user ordering, historical serialization stability, absent-context compatibility, Pi/Claude/Codex rendering, security policy and overlays, untrusted retrieved text framing, background callers, and consecutive-turn common-prefix behavior.

The cache-friendly run was materially faster after warm-up. This is consistent with reuse of the PhantomBot-controlled stable prefix even while retrieved context changed. The recommendation is to make this layout permanent after review, then remove the temporary gate in a follow-up. Persistent Pi/RPC, explicit llama.cpp slot management, and other separate experiments were not implemented.

## Validation notes

- `bun test tests/cache-friendly-prompt-layout.test.ts`: passed, 9/9.
- `bun tsc --noEmit`: blocked by the Windows Bun/TypeScript process exhausting available memory; direct `tsc.exe` showed the same heap exhaustion.
- `bun run build`: bundling and compilation completed, but the Windows compile step failed while releasing double-mapped memory; no source compilation error was reported.
- `bun test`: existing Windows baseline failures were observed in subprocess fixtures, temporary-directory cleanup, CLI exit-code expectations, and MCP integration timeouts. The new cache-layout tests passed; unrelated baseline failures were not changed.

No benchmark artifacts, databases, logs, private prompts, or machine-specific paths are tracked.

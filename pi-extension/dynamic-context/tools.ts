/**
 * Pure data handling for the dynamic vLLM context extension.
 *
 * The endpoint is authoritative for contextWindow. The provider's static
 * models.json entries remain the source for every other model property.
 */

export const MIN_CONTEXT_WINDOW = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;
/** Keep room for the next model/tool cycle after a proactive compaction. */
export const MID_LOOP_COMPACTION_RESERVE_TOKENS = 16_384;

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
}

export interface MidLoopCompactionDecision {
  trigger: boolean;
  currentTokens?: number;
  contextWindow?: number;
  threshold?: number;
}

export interface MidLoopTurnEvent {
  message?: { stopReason?: unknown };
}

export interface MidLoopCompactionContext {
  getContextUsage(): ContextUsageSnapshot | undefined;
  compact(options: {
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }): void;
}

export interface MidLoopPiApi {
  on(
    event: "turn_end",
    handler: (event: MidLoopTurnEvent, ctx: MidLoopCompactionContext) =>
      | void
      | Promise<void>,
  ): void;
}

/**
 * Decide whether a Pi tool loop should compact before its next model call.
 * `toolUse` is deliberately required: terminal turns above the threshold are
 * left to Pi's normal end-of-run compaction semantics.
 */
export function shouldProactivelyCompact(
  stopReason: unknown,
  usage: ContextUsageSnapshot | undefined,
  guardArmed: boolean,
): MidLoopCompactionDecision {
  if (stopReason !== "toolUse" || !usage || !guardArmed) return { trigger: false };
  const currentTokens = usage.tokens;
  if (
    currentTokens === null ||
    !Number.isSafeInteger(currentTokens) ||
    !Number.isSafeInteger(usage.contextWindow) ||
    usage.contextWindow < MIN_CONTEXT_WINDOW
  ) {
    return { trigger: false };
  }
  const threshold = Math.max(
    0,
    usage.contextWindow - MID_LOOP_COMPACTION_RESERVE_TOKENS,
  );
  return {
    trigger: currentTokens >= threshold,
    currentTokens,
    contextWindow: usage.contextWindow,
    threshold,
  };
}

/**
 * Install the one-shot mid-loop guard used by the managed Pi extension.
 * Keeping the lifecycle wiring here makes the policy independently testable
 * without importing Pi's runtime package into the data-handling tests.
 */
export function installMidLoopCompactionGuard(pi: MidLoopPiApi): void {
  let compactionInFlight = false;
  let guardArmed = true;
  let lastContextWindow: number | undefined;

  pi.on("turn_end", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.contextWindow !== lastContextWindow) {
      lastContextWindow = usage?.contextWindow;
      guardArmed = true;
    }
    if (
      usage?.tokens !== null &&
      usage?.tokens !== undefined &&
      usage.tokens < (usage.contextWindow - MID_LOOP_COMPACTION_RESERVE_TOKENS)
    ) {
      guardArmed = true;
    }

    const decision = shouldProactivelyCompact(
      event.message?.stopReason,
      usage,
      guardArmed,
    );
    if (!decision.trigger || compactionInFlight) return;

    guardArmed = false;
    compactionInFlight = true;
    const fields = {
      currentTokens: decision.currentTokens,
      contextWindow: decision.contextWindow,
      threshold: decision.threshold,
      reason: "mid_loop_context_guard",
    };
    console.warn(
      `phantombot: proactive Pi compaction started ` +
        `${fields.currentTokens}/${fields.contextWindow} ` +
        `(threshold ${fields.threshold}, reason=${fields.reason})`,
    );
    try {
      await new Promise<void>((resolve) => {
        try {
          ctx.compact({
            onComplete: () => {
              console.warn(
                `phantombot: proactive Pi compaction completed ` +
                  `${fields.currentTokens}/${fields.contextWindow}`,
              );
              resolve();
            },
            onError: (error) => {
              console.warn(
                `phantombot: proactive Pi compaction failed ` +
                  `${fields.currentTokens}/${fields.contextWindow}: ${error.message}`,
              );
              resolve();
            },
          });
        } catch (error) {
          console.warn(
            `phantombot: proactive Pi compaction failed ` +
              `${fields.currentTokens}/${fields.contextWindow}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          resolve();
        }
      });
    } finally {
      compactionInFlight = false;
    }
  });
}

export interface StaticProviderConfig {
  api?: string;
  baseUrl?: string;
  models?: Record<string, StaticModelConfig> | StaticModelConfig[];
}

export interface StaticModelConfig {
  id?: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    [key: string]: unknown;
  };
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface RegisteredModelConfig {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    [key: string]: unknown;
  };
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validContextWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_CONTEXT_WINDOW &&
    value <= MAX_CONTEXT_WINDOW
  );
}

/** Read the vLLM /v1/models `max_model_len` field without profile knowledge. */
export function parseRuntimeContexts(payload: unknown): Map<string, number> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return new Map();

  const contexts = new Map<string, number>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (validContextWindow(item.max_model_len)) {
      contexts.set(item.id, item.max_model_len);
    }
  }
  return contexts;
}

function staticEntries(
  models: StaticProviderConfig["models"],
): Array<[string, StaticModelConfig]> {
  if (Array.isArray(models)) {
    return models.flatMap((model) => {
      const id = typeof model.id === "string" ? model.id : undefined;
      return id ? [[id, model] as [string, StaticModelConfig]] : [];
    });
  }
  if (!isRecord(models)) return [];
  return Object.entries(models).filter(
    (entry): entry is [string, StaticModelConfig] => isRecord(entry[1]),
  );
}

/**
 * Convert the existing vLLM models.json entries to Pi registration entries,
 * changing only contextWindow for model ids returned by the endpoint.
 */
export function registeredModelsWithRuntimeContexts(
  provider: StaticProviderConfig,
  contexts: ReadonlyMap<string, number>,
): RegisteredModelConfig[] {
  return staticEntries(provider.models).map(([id, model]) => ({
    id,
    name: model.name ?? id,
    ...(model.api ?? provider.api ? { api: model.api ?? provider.api } : {}),
    ...(model.baseUrl ?? provider.baseUrl
      ? { baseUrl: model.baseUrl ?? provider.baseUrl }
      : {}),
    reasoning: model.reasoning ?? false,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input ?? ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contexts.get(id) ?? model.contextWindow ?? 4_096,
    // Pi's current default for this provider is 16,384; runtime context must
    // never silently turn into a larger output-token budget.
    maxTokens: model.maxTokens ?? 16_384,
    ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  }));
}

export function runtimeModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("models", normalized).toString();
}

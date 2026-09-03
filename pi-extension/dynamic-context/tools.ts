/**
 * Pure data handling for the dynamic vLLM context extension.
 *
 * The endpoint is authoritative for contextWindow. The provider's static
 * models.json entries remain the source for every other model property.
 */

export const MIN_CONTEXT_WINDOW = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;

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


/**
 * Pure data handling for the dynamic local-provider extension.
 *
 * vLLM exposes one static model list with runtime context metadata. llama.cpp
 * exposes the router's actual profile catalog, so that catalog is authoritative
 * for which model ids Pi may select and for runtime-derived capabilities.
 */

export const MIN_CONTEXT_WINDOW = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;
const CONTEXT_ARGS = new Set([
  "--ctx-size",
  "--context-size",
  "-c",
  "-ctx",
]);

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
  contextWindow?: number;
  maxTokens?: number;
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

export interface RuntimeModelCatalogEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}

function runtimeStatusFailed(item: Record<string, unknown>): boolean {
  if (
    item.failed === true ||
    (item.error !== undefined && item.error !== null)
  ) {
    return true;
  }
  const status = item.status;
  if (isRecord(status) && status.failed === true) return true;
  const value =
    typeof status === "string"
      ? status
      : isRecord(status) && typeof status.value === "string"
        ? status.value
        : undefined;
  return (
    value !== undefined &&
    ["failed", "error", "unavailable"].includes(value.toLowerCase())
  );
}

function contextFromArgs(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") continue;
    const argument = value[index];
    const equals = argument.match(/^(--ctx-size|--context-size|-c|-ctx)=(\d+)$/);
    if (equals?.[2] && validContextWindow(Number(equals[2]))) return Number(equals[2]);
    if (!CONTEXT_ARGS.has(argument)) continue;
    const next = value[index + 1];
    if (
      typeof next === "string" &&
      /^\d+$/.test(next) &&
      validContextWindow(Number(next))
    ) {
      return Number(next);
    }
  }
  return undefined;
}

function runtimeContextWindow(item: Record<string, unknown>): number | undefined {
  const status = isRecord(item.status) ? item.status : undefined;
  const argsContext = contextFromArgs(status?.args ?? item.args);
  if (argsContext !== undefined) return argsContext;
  for (const value of [
    item.context_length,
    item.active_context_length,
    item.n_ctx,
    isRecord(item.meta) ? item.meta.n_ctx : undefined,
  ]) {
    if (validContextWindow(value)) return value;
  }
  return undefined;
}

function runtimeInput(item: Record<string, unknown>): Array<"text" | "image"> | undefined {
  const architecture = isRecord(item.architecture) ? item.architecture : undefined;
  const modalities = architecture?.input_modalities;
  if (
    !Array.isArray(modalities) ||
    !modalities.every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return modalities.includes("image") ? ["text", "image"] : ["text"];
}

/** Read the llama.cpp router's live `/v1/models` profile catalog. */
export function parseRuntimeModelCatalog(
  payload: unknown,
): RuntimeModelCatalogEntry[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;

  const catalog: RuntimeModelCatalogEntry[] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    if (item.id === "default" || runtimeStatusFailed(item)) continue;
    const contextWindow = runtimeContextWindow(item);
    const input = runtimeInput(item);
    const entry: RuntimeModelCatalogEntry = {
      id: item.id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(contextWindow !== undefined
        ? { contextWindow }
        : {}),
      ...(typeof item.reasoning === "boolean" ? { reasoning: item.reasoning } : {}),
      ...(input ? { input } : {}),
    };
    catalog.push(entry);
  }
  return catalog;
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

/**
 * Register exactly the profiles the llama.cpp router advertises. Static Pi
 * metadata is overlaid where available; newly discovered profiles receive
 * only metadata that the router actually reports.
 */
export function registeredModelsWithRuntimeCatalog(
  provider: StaticProviderConfig,
  catalog: readonly RuntimeModelCatalogEntry[],
): RegisteredModelConfig[] {
  const configured = new Map(staticEntries(provider.models));
  return catalog.map((runtime) => {
    const model = configured.get(runtime.id) ?? {};
    return {
      id: runtime.id,
      name: model.name ?? runtime.name ?? runtime.id,
      ...(model.api ?? provider.api ? { api: model.api ?? provider.api } : {}),
      ...(model.baseUrl ?? provider.baseUrl
        ? { baseUrl: model.baseUrl ?? provider.baseUrl }
        : {}),
      reasoning: model.reasoning ?? runtime.reasoning ?? false,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      input: model.input ?? runtime.input ?? ["text"],
      cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(runtime.contextWindow !== undefined || model.contextWindow !== undefined
        ? { contextWindow: runtime.contextWindow ?? model.contextWindow }
        : {}),
      // Pi 0.84.2's --list-models formatter requires a finite maxTokens
      // value for extension-registered models. This is the existing
      // conservative request ceiling, not a claim about the model's native
      // output limit (which llama.cpp does not report here).
      maxTokens: model.maxTokens ?? 16_384,
      ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.compat ? { compat: model.compat } : {}),
    };
  });
}

export function runtimeModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("models", normalized).toString();
}

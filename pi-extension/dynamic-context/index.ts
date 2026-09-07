/**
 * Dynamic local-provider capability and model discovery for phantombot.
 *
 * Pi loads async extension factories before resolving a selected model and
 * before `--list-models` renders its table. That makes this the correct place
 * to ask local providers for live context/capability metadata and the
 * llama.cpp router for its selectable profile catalog.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseRuntimeContexts,
  parseRuntimeModelCatalog,
  registeredModelsWithRuntimeCatalog,
  registeredModelsWithRuntimeContexts,
  runtimeModelsUrl,
  type StaticProviderConfig,
} from "./tools.ts";

const PROVIDER_ID = "vllm";
const LLAMACPP_PROVIDER_ID = "llamacpp";
const RUNTIME_FIELD = "max_model_len";
const PROBE_TIMEOUT_MS = 1_500;

function agentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")
  );
}

async function configuredProvider(
  providerId: string,
): Promise<StaticProviderConfig | undefined> {
  try {
    const raw = await readFile(join(agentDir(), "models.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const provider = (parsed as { providers?: unknown }).providers;
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      return undefined;
    }
    const configured = (provider as Record<string, unknown>)[providerId];
    return typeof configured === "object" && configured !== null && !Array.isArray(configured)
      ? (configured as StaticProviderConfig)
      : undefined;
  } catch (error) {
    console.warn(
      `phantombot: dynamic ${providerId} discovery skipped; ` +
        `could not read models.json (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

export default async function dynamicContextExtension(pi: ExtensionAPI): Promise<void> {
  // Do not call ctx.compact() from turn_end: Pi 0.84.x can abort the active
  // tool loop before it emits its normal completion lifecycle. Dynamic
  // context discovery remains safe here; compaction belongs at Pi's own
  // agent-loop boundary (or a pinned Pi-side fix).
  const vllm = await configuredProvider(PROVIDER_ID);
  if (vllm?.baseUrl && vllm.models) {
    await refreshVllmContexts(pi, vllm);
  }

  const llamacpp = await configuredProvider(LLAMACPP_PROVIDER_ID);
  if (llamacpp?.baseUrl) {
    await refreshLlamacppCatalog(pi, llamacpp);
  }
}

async function refreshVllmContexts(
  pi: ExtensionAPI,
  provider: StaticProviderConfig,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(runtimeModelsUrl(provider.baseUrl), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `phantombot: dynamic ${PROVIDER_ID} context discovery unavailable; ` +
        `keeping static Pi metadata (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  if (!response.ok) {
    console.warn(
      `phantombot: dynamic ${PROVIDER_ID} context discovery returned HTTP ${response.status}; ` +
        "keeping static Pi metadata",
    );
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn(
      `phantombot: dynamic ${PROVIDER_ID} context discovery returned malformed JSON; ` +
        `keeping static Pi metadata (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  const contexts = parseRuntimeContexts(payload);
  if (contexts.size === 0) {
    console.warn(
      `phantombot: dynamic ${PROVIDER_ID} context discovery found no valid numeric ` +
        `${RUNTIME_FIELD} values; keeping static Pi metadata`,
    );
    return;
  }

  const models = registeredModelsWithRuntimeContexts(provider, contexts);
  const matched = models.filter((model) => contexts.has(model.id));
  if (matched.length === 0) {
    console.warn(
      `phantombot: dynamic ${PROVIDER_ID} context discovery returned no configured ` +
        "model ids; keeping static Pi metadata",
    );
    return;
  }

  // Register the complete configured vLLM list. Pi replaces one provider's
  // extension model list, so preserving every static vLLM entry here prevents
  // unrelated models from disappearing; other providers are untouched.
  pi.registerProvider(PROVIDER_ID, { models });
}

async function refreshLlamacppCatalog(
  pi: ExtensionAPI,
  provider: StaticProviderConfig,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(runtimeModelsUrl(provider.baseUrl!), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `phantombot: dynamic ${LLAMACPP_PROVIDER_ID} catalog unavailable; ` +
        `keeping static Pi metadata (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  if (!response.ok) {
    console.warn(
      `phantombot: dynamic ${LLAMACPP_PROVIDER_ID} catalog returned HTTP ${response.status}; ` +
        "keeping static Pi metadata",
    );
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn(
      `phantombot: dynamic ${LLAMACPP_PROVIDER_ID} catalog returned malformed JSON; ` +
        `keeping static Pi metadata (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  const catalog = parseRuntimeModelCatalog(payload);
  if (catalog === undefined) {
    console.warn(
      `phantombot: dynamic ${LLAMACPP_PROVIDER_ID} catalog had no valid data array; ` +
        "keeping static Pi metadata",
    );
    return;
  }

  // The router catalog is authoritative here. This adds newly configured
  // profiles (including Gemma) and removes failed/stale profiles, while the
  // static entry still supplies Pi-only fields such as reasoning preferences.
  pi.registerProvider(LLAMACPP_PROVIDER_ID, {
    models: registeredModelsWithRuntimeCatalog(provider, catalog),
  });
}

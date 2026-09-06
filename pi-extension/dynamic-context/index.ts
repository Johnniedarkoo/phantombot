/**
 * Dynamic local-provider capability discovery for phantombot.
 *
 * Pi loads async extension factories before resolving a selected model and
 * before `--list-models` renders its table. That makes this the correct place
 * to ask the configured vLLM endpoint for its live context capacity.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installMidLoopCompactionGuard,
  parseRuntimeContexts,
  registeredModelsWithRuntimeContexts,
  runtimeModelsUrl,
  type StaticProviderConfig,
} from "./tools.ts";

const PROVIDER_ID = "vllm";
const RUNTIME_FIELD = "max_model_len";
const PROBE_TIMEOUT_MS = 1_500;

function agentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")
  );
}

async function configuredVllmProvider(): Promise<StaticProviderConfig | undefined> {
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
    const vllm = (provider as Record<string, unknown>)[PROVIDER_ID];
    return typeof vllm === "object" && vllm !== null && !Array.isArray(vllm)
      ? (vllm as StaticProviderConfig)
      : undefined;
  } catch (error) {
    console.warn(
      `phantombot: dynamic ${PROVIDER_ID} context discovery skipped; ` +
        `could not read models.json (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

export default async function dynamicContextExtension(pi: ExtensionAPI): Promise<void> {
  installMidLoopCompactionGuard(pi);

  const provider = await configuredVllmProvider();
  if (!provider?.baseUrl || !provider.models) return;

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

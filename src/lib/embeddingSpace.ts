import { createHash } from "node:crypto";
import type { Config } from "../config.ts";

export type EmbeddingProvider = "gemini" | "openai-compatible";

/** The document-vector space, excluding query-only encoding choices. */
export interface EmbeddingSpace {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  documentPrefix: string;
  fingerprint: string;
}

/**
 * Build the stable identity of a document-vector space. Keep this canonical
 * object deliberately small: credentials and queryPrefix do not change the
 * meaning of stored document vectors, while an OpenAI-compatible document
 * prefix does.
 */
export function makeEmbeddingSpace(input: {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  documentPrefix?: string;
}): EmbeddingSpace {
  const documentPrefix =
    input.provider === "openai-compatible" ? input.documentPrefix ?? "" : "";
  const canonical = JSON.stringify({
    dimensions: Math.floor(input.dimensions),
    documentPrefix,
    model: input.model,
    provider: input.provider,
    version: 1,
  });
  return {
    provider: input.provider,
    model: input.model,
    dimensions: Math.floor(input.dimensions),
    documentPrefix,
    fingerprint: `v1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
  };
}

/** Resolve the current configured space, or undefined until dimensions exist. */
export function embeddingSpaceForConfig(
  config: Pick<Config, "embeddings"> | Config["embeddings"],
): EmbeddingSpace | undefined {
  const embeddings = "embeddings" in config ? config.embeddings : config;
  if (embeddings.provider === "gemini") {
    const g = embeddings.gemini;
    if (!g?.model || !Number.isInteger(g.dims) || g.dims <= 0) return undefined;
    return makeEmbeddingSpace({
      provider: "gemini",
      model: g.model,
      dimensions: g.dims,
    });
  }
  if (embeddings.provider === "openai-compatible") {
    const o = embeddings.openaiCompatible;
    if (
      !o?.model ||
      !Number.isInteger(o.dims) ||
      o.dims <= 0
    ) return undefined;
    return makeEmbeddingSpace({
      provider: "openai-compatible",
      model: o.model,
      dimensions: o.dims,
      documentPrefix: o.documentPrefix,
    });
  }
  return undefined;
}

/** Untagged rows can only have come from upstream's Gemini-only provider. */
export function acceptsLegacyGeminiRows(space: EmbeddingSpace): boolean {
  return space.provider === "gemini";
}


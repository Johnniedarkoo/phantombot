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

/**
 * Untagged rows predate per-row provenance. The only defensible inference is
 * the historical upstream Gemini default; a configurable Gemini model or
 * dimension could have produced a different vector space, so it must be
 * reembedded rather than guessed.
 */
export function acceptsLegacyGeminiRows(space: EmbeddingSpace): boolean {
  return (
    space.provider === "gemini" &&
    space.model === "gemini-embedding-001" &&
    space.dimensions === 1536
  );
}

/** Shared row-level compatibility predicate for tagged and legacy vectors. */
export function embeddingRowMatchesSpace(
  rowFingerprint: string | null | undefined,
  space: EmbeddingSpace,
): boolean {
  return (
    rowFingerprint === space.fingerprint ||
    (rowFingerprint == null && acceptsLegacyGeminiRows(space))
  );
}

/** Build the SQLite equivalent of embeddingRowMatchesSpace. */
export function embeddingSpaceSqlPredicate(
  space: EmbeddingSpace,
  column = "space_fingerprint",
): { sql: string; params: [string] } {
  return acceptsLegacyGeminiRows(space)
    ? {
        sql: `(${column} = ? OR ${column} IS NULL)`,
        params: [space.fingerprint],
      }
    : { sql: `${column} = ?`, params: [space.fingerprint] };
}

/** Generic embedding-provider resolution used by all memory consumers. */

import type { Config } from "../config.ts";
import { geminiEmbed, type EmbedResult } from "./geminiEmbed.ts";
import { openaiCompatibleEmbed } from "./openaiCompatibleEmbed.ts";

export type Embedder = (
  text: string,
  signal?: AbortSignal,
) => Promise<EmbedResult>;

export interface ResolvedEmbedders {
  query?: Embedder;
  document?: Embedder;
}

export interface ResolveEmbeddersOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the configured query and document embedders. `none` intentionally
 * resolves to no functions so callers retain their existing lexical/OKF path.
 */
export function resolveEmbedders(
  config: Pick<Config, "embeddings"> | Config["embeddings"],
  opts: ResolveEmbeddersOptions = {},
): ResolvedEmbedders {
  const embeddings = "embeddings" in config ? config.embeddings : config;
  if (embeddings.provider === "none") return {};

  if (embeddings.provider === "gemini") {
    const g = embeddings.gemini;
    if (!g?.apiKey) return {};
    const embed: Embedder = (text, signal) =>
      geminiEmbed(g.apiKey, text, {
        model: g.model,
        dims: g.dims,
        signal,
        fetchImpl: opts.fetchImpl,
      });
    return { query: embed, document: embed };
  }

  const o = embeddings.openaiCompatible;
  if (!o?.baseUrl || !o.model) return {};
  const make = (prefix: string): Embedder => (text, signal) =>
    openaiCompatibleEmbed(`${prefix}${text}`, {
      baseUrl: o.baseUrl,
      model: o.model,
      apiKey: o.apiKey,
      dims: o.dims,
      fetchImpl: opts.fetchImpl,
      signal,
    });
  return {
    query: make(o.queryPrefix),
    document: make(o.documentPrefix),
  };
}

export type { EmbedResult };

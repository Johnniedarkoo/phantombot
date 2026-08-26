/** Generic embedding-provider resolution used by all memory consumers. */

import type { Config } from "../config.ts";
import { geminiEmbed, type EmbedResult } from "./geminiEmbed.ts";
import { openaiCompatibleEmbed } from "./openaiCompatibleEmbed.ts";
import {
  embeddingSpaceForConfig,
  type EmbeddingSpace,
} from "./embeddingSpace.ts";

export type Embedder = ((
  text: string,
  signal?: AbortSignal,
) => Promise<EmbedResult>) & { space?: EmbeddingSpace };

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
    const space = embeddingSpaceForConfig(embeddings);
    if (!g?.apiKey || !space) return {};
    const embed = Object.assign(((text: string, signal?: AbortSignal) =>
      geminiEmbed(g.apiKey, text, {
        model: g.model,
        dims: g.dims,
        signal,
        fetchImpl: opts.fetchImpl,
      })) as Embedder, { space });
    return { query: embed, document: embed };
  }

  const o = embeddings.openaiCompatible;
  const space = embeddingSpaceForConfig(embeddings);
  if (!o?.baseUrl || !o.model || !space) return {};
  const make = (prefix: string): Embedder => Object.assign((
    (text: string, signal?: AbortSignal) =>
      openaiCompatibleEmbed(`${prefix}${text}`, {
        baseUrl: o.baseUrl,
        model: o.model,
        apiKey: o.apiKey,
        dims: o.dims,
        fetchImpl: opts.fetchImpl,
        signal,
      })
  ) as Embedder, { space });
  return {
    query: make(o.queryPrefix),
    document: make(o.documentPrefix),
  };
}

export type { EmbedResult };

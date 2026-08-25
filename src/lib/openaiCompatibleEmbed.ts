/**
 * OpenAI-compatible embeddings client.
 *
 * The client deliberately knows only the standard /embeddings wire format.
 * Provider-specific query/document prefixes are applied by the resolver, not
 * here, so this remains usable with llama-server and other compatible hosts.
 */

import type { EmbedResult } from "./geminiEmbed.ts";

export interface OpenAICompatibleEmbedOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 0 means that the response dimension is accepted and returned. */
  dims?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function openaiCompatibleEmbed(
  text: string,
  opts: OpenAICompatibleEmbedOptions,
): Promise<EmbedResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, error: "base URL is empty" };
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const apiKey = opts.apiKey?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        input: text,
        encoding_format: "float",
      }),
      signal: opts.signal,
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `non-JSON response (HTTP ${res.status})` };
  }

  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "object" &&
      (body as { error?: { message?: unknown } }).error !== null
        ? (body as { error?: { message?: unknown } }).error?.message
        : undefined;
    return {
      ok: false,
      error: typeof message === "string" && message.length > 0
        ? message
        : `HTTP ${res.status}`,
    };
  }

  const embedding =
    typeof body === "object" && body !== null && "data" in body &&
    Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: Array<{ embedding?: unknown }> }).data[0]?.embedding
      : undefined;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return { ok: false, error: "no embedding in response data[0]" };
  }

  const out = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: "non-numeric value in embedding" };
    }
    out[i] = value;
  }
  if (opts.dims !== undefined && opts.dims > 0 && out.length !== opts.dims) {
    return {
      ok: false,
      error: `embedding dimension mismatch: expected ${opts.dims}, got ${out.length}`,
    };
  }
  return { ok: true, values: out, dims: out.length };
}

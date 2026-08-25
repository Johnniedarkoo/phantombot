/**
 * Embedding job — feeds the note_embeddings table.
 *
 * Iterates every (path, scope) row in the FTS5 `files` table, chunks the
 * file content if it's too large for a single embedding call, and embeds
 * each chunk via the configured provider. Skips chunks whose text_sha
 * matches the recorded value (no API call needed).
 *
 * Sequential, not parallel — avoids hitting Gemini's per-minute quota.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { resolveEmbedders, type Embedder } from "./embedder.ts";
import type { MemoryIndex } from "./memoryIndex.ts";

/** Roughly 6000 tokens of slack-padded room for Gemini's 8192 limit. */
const MAX_CHARS_PER_CHUNK = 18_000;

export interface EmbedJobResult {
  totalNotes: number;
  embedded: number;
  skipped: number;
  failed: number;
  errors: Array<{ path: string; chunkIdx: number; error: string }>;
}

export type { Embedder } from "./embedder.ts";

export function defaultEmbedder(config: Config): Embedder | undefined {
  return resolveEmbedders(config).document;
}

export function defaultEmbedderWithFetch(
  config: Config,
  fetchImpl?: typeof fetch,
): Embedder | undefined {
  return resolveEmbedders(config, { fetchImpl }).document;
}

export interface RunEmbedJobInput {
  personaDir: string;
  index: MemoryIndex;
  embedder: Embedder;
  /** If true, re-embed every chunk regardless of sha match. */
  force?: boolean;
}

export async function runEmbedJob(
  input: RunEmbedJobInput,
): Promise<EmbedJobResult> {
  const result: EmbedJobResult = {
    totalNotes: 0,
    embedded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Pull the full file list straight from the FTS index (which has been
  // populated by refreshStale before we get here).
  const files = (
    input.index as unknown as {
      db: import("bun:sqlite").Database;
    }
  ).db
    .query("SELECT path FROM files ORDER BY path")
    .all() as Array<{ path: string }>;

  for (const { path } of files) {
    result.totalNotes++;
    let content: string;
    try {
      content = await readFile(join(input.personaDir, path), "utf8");
    } catch {
      // File listed in `files` but no longer on disk — skip silently;
      // refreshStale will catch and remove it on next call.
      continue;
    }

    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const sha = sha256(chunk);
      if (!input.force) {
        const recorded = input.index.embeddingSha(path, i);
        if (recorded === sha) {
          result.skipped++;
          continue;
        }
      }
      const r = await input.embedder(chunk);
      if (!r.ok) {
        result.failed++;
        result.errors.push({ path, chunkIdx: i, error: r.error });
        continue;
      }
      input.index.upsertEmbedding(path, i, r.values, sha);
      result.embedded++;
    }
  }

  return result;
}

export interface TurnEmbedJobResult {
  totalTurns: number;
  embedded: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
}

/** Re-embed every existing indexed turn; deliberately ignores cursor state. */
export async function runTurnEmbedJob(input: {
  index: MemoryIndex;
  embedder: Embedder;
}): Promise<TurnEmbedJobResult> {
  const result: TurnEmbedJobResult = {
    totalTurns: 0,
    embedded: 0,
    failed: 0,
    errors: [],
  };
  for (const row of input.index.allTurnDocuments()) {
    result.totalTurns++;
    const r = await input.embedder(row.content);
    if (!r.ok) {
      result.failed++;
      result.errors.push({ path: row.path, error: r.error });
      continue;
    }
    input.index.upsertTurnEmbedding(row.path, r.values, sha256(row.content));
    result.embedded++;
  }
  return result;
}

export function chunkText(text: string): string[] {
  if (text.length <= MAX_CHARS_PER_CHUNK) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHARS_PER_CHUNK) {
    out.push(text.slice(i, i + MAX_CHARS_PER_CHUNK));
  }
  return out;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

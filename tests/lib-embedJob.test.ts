/**
 * Tests for the embed job + hybrid search pipeline.
 *
 * Uses a fake embedder so we don't hit Gemini.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkText,
  defaultEmbedder,
  runEmbedJob,
  runTurnEmbedJob,
  sha256,
} from "../src/lib/embedJob.ts";
import {
  cosineSimilarity,
  MemoryIndex,
  rrfMerge,
} from "../src/lib/memoryIndex.ts";

let workdir: string;
let personaDir: string;
let ix: MemoryIndex;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-emb-"));
  personaDir = join(workdir, "persona");
  await mkdir(join(personaDir, "memory"), { recursive: true });
  await mkdir(join(personaDir, "kb", "concepts"), { recursive: true });
  ix = await MemoryIndex.open(":memory:");
});

afterEach(async () => {
  ix.close();
  await rm(workdir, { recursive: true, force: true });
});

async function note(rel: string, content: string) {
  await writeFile(join(personaDir, rel), content);
}

/**
 * Deterministic fake embedder. Returns a 4-dim vector seeded by the
 * first character of the input — different chars → different vectors.
 */
function fakeEmbedder() {
  return async (text: string) => {
    const code = text.charCodeAt(0) || 0;
    const v = new Float32Array(4);
    v[0] = (code % 7) / 10;
    v[1] = ((code + 3) % 11) / 10;
    v[2] = ((code + 5) % 13) / 10;
    v[3] = ((code + 7) % 17) / 10;
    // Normalize so cosine similarity is well-defined
    let n = 0;
    for (const x of v) n += x * x;
    const len = Math.sqrt(n);
    if (len > 0) for (let i = 0; i < v.length; i++) v[i]! /= len;
    return { ok: true as const, values: v, dims: 4 };
  };
}

describe("chunkText", () => {
  test("returns single chunk for short text", () => {
    expect(chunkText("hello", 18_000)).toEqual(["hello"]);
  });

  test("splits long text without exceeding the requested limit", () => {
    const long = "x".repeat(40_000);
    const chunks = chunkText(long, 18_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 18_000)).toBe(true);
    expect(chunks.join("")).toBe(long);
  });

  test("prefers a nearby paragraph boundary", () => {
    const text = "a".repeat(14) + "\n\n" + "b".repeat(20);
    const chunks = chunkText(text, 20);
    expect(chunks[0]).toBe("a".repeat(14) + "\n\n");
    expect(chunks.join("")).toBe(text);
  });

  test("falls back to a nearby newline", () => {
    const text = "a".repeat(14) + "\n" + "b".repeat(20);
    const chunks = chunkText(text, 20);
    expect(chunks[0]).toBe("a".repeat(14) + "\n");
    expect(chunks.join("")).toBe(text);
  });

  test("hard-splits when no useful boundary exists", () => {
    const text = "x".repeat(45);
    const chunks = chunkText(text, 20);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(chunks.join("")).toBe(text);
  });
});

describe("sha256", () => {
  test("is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("world"));
  });
});

describe("cosineSimilarity", () => {
  test("identical vectors have similarity ~1", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    expect(Math.abs(cosineSimilarity(a, a) - 1)).toBeLessThan(0.0001);
  });

  test("orthogonal vectors have similarity 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("opposite vectors have similarity -1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBe(-1);
  });

  test("zero vectors return 0 (no division by zero)", () => {
    const z = new Float32Array([0, 0, 0]);
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(z, a)).toBe(0);
  });
  test("dimension mismatch is safe and returns no similarity", () => {
    expect(
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1])),
    ).toBe(0);
  });
});

describe("rrfMerge", () => {
  test("blends two ranked lists with reciprocal-rank weighting", () => {
    const a = ["x", "y", "z"];
    const b = ["y", "x", "w"];
    const m = rrfMerge([a, b]);
    // y is #1 in b and #2 in a — should beat or tie x
    expect((m.get("y") ?? 0)).toBeGreaterThan(0);
    expect((m.get("x") ?? 0)).toBeGreaterThan(0);
    expect((m.get("w") ?? 0)).toBeGreaterThan(0);
    expect((m.get("z") ?? 0)).toBeGreaterThan(0);
    // y is in BOTH lists at high rank — outscores z (only in a, low rank)
    expect((m.get("y") ?? 0)).toBeGreaterThan((m.get("z") ?? 0));
  });
});

describe("MemoryIndex embedding storage", () => {
  test("upsertEmbedding round-trips a Float32Array", () => {
    const v = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    ix.upsertEmbedding("kb/A.md", 0, v, "sha-1");
    expect(ix.embeddingCount()).toBe(1);
    expect(ix.embeddingSha("kb/A.md", 0)).toBe("sha-1");
    const all = ix.allEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0]?.path).toBe("kb/A.md");
    expect(all[0]?.chunkIdx).toBe(0);
    expect(all[0]?.vec.length).toBe(4);
    expect(Math.abs(all[0]!.vec[0]! - 0.1)).toBeLessThan(0.0001);
  });

  test("INSERT OR REPLACE on the same (path, chunk_idx)", () => {
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0, 1]);
    ix.upsertEmbedding("kb/A.md", 0, v1, "sha-1");
    ix.upsertEmbedding("kb/A.md", 0, v2, "sha-2");
    expect(ix.embeddingCount()).toBe(1);
    expect(ix.embeddingSha("kb/A.md", 0)).toBe("sha-2");
  });

  test("clearing vectors preserves FTS and indexed turn documents", async () => {
    await note("kb/concepts/A.md", "alpha content");
    await ix.refreshStale(personaDir);
    ix.upsertEmbedding("kb/concepts/A.md", 0, new Float32Array([1, 0]), "sha");
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "historical turn",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    }, new Float32Array([0, 1]), "turn-sha");
    expect(ix.embeddingCount()).toBe(2);
    expect(ix.search("alpha")).toHaveLength(1);
    expect(ix.allTurnDocuments()).toHaveLength(1);
    ix.clearEmbeddings();
    expect(ix.embeddingCount()).toBe(0);
    expect(ix.search("alpha")).toHaveLength(1);
    expect(ix.allTurnDocuments()).toHaveLength(1);
  });

  test("re-embeds every historical turn document, not only missing rows", async () => {
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "first historical turn",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "cli:default",
      role: "assistant",
      text: "second historical turn",
      createdAt: new Date("2026-01-01T00:01:00Z"),
      embeddable: true,
      source: "unverified",
      origin: "channel",
    });
    const r = await runTurnEmbedJob({ index: ix, embedder: fakeEmbedder() });
    expect(r.totalTurns).toBe(2);
    expect(r.embedded).toBe(2);
    expect(ix.embeddingCount()).toBe(2);
  });
});

describe("runEmbedJob", () => {
  test("embeds every note (skipped on second pass via sha match)", async () => {
    await note("kb/concepts/A.md", "alpha content");
    await note("kb/concepts/B.md", "beta content");
    await ix.refreshStale(personaDir);

    const r1 = await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 18_000,
    });
    expect(r1.totalNotes).toBe(2);
    expect(r1.totalFiles).toBe(2);
    expect(r1.totalChunks).toBe(2);
    expect(r1.embeddedChunks).toBe(2);
    expect(r1.embedded).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(r1.failed).toBe(0);

    const r2 = await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 18_000,
    });
    expect(r2.skipped).toBe(2);
    expect(r2.embedded).toBe(0);
  });

  test("force=true re-embeds everything", async () => {
    await note("kb/concepts/A.md", "alpha");
    await ix.refreshStale(personaDir);
    await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 18_000,
    });
    const r = await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 18_000,
      force: true,
    });
    expect(r.embedded).toBe(1);
    expect(r.skipped).toBe(0);
  });

  test("records failures without aborting the whole job", async () => {
    await note("kb/concepts/A.md", "alpha");
    await note("kb/concepts/B.md", "beta");
    await ix.refreshStale(personaDir);
    const flaky = async (text: string) =>
      text.startsWith("alpha")
        ? { ok: false as const, error: "rate limited" }
        : { ok: true as const, values: new Float32Array([0.5, 0.5, 0.5, 0.5]), dims: 4 };
    const r = await runEmbedJob({
      personaDir,
      index: ix,
      embedder: flaky,
      maxChunkChars: 18_000,
    });
    expect(r.embedded).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.path).toBe("kb/concepts/A.md");
  });

  test("uses the supplied limit to split an oversized note into successful calls", async () => {
    await note("kb/concepts/oversized.md", "x".repeat(25));
    await ix.refreshStale(personaDir);
    const calls: string[] = [];
    const guardedEmbedder = async (text: string) => {
      calls.push(text);
      if (text.length > 10) {
        return { ok: false as const, error: "request too large" };
      }
      return {
        ok: true as const,
        values: new Float32Array([1, 0, 0, 0]),
        dims: 4,
      };
    };

    const r = await runEmbedJob({
      personaDir,
      index: ix,
      embedder: guardedEmbedder,
      maxChunkChars: 10,
    });
    expect(r.embedded).toBe(3);
    expect(r.failed).toBe(0);
    expect(calls).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(ix.embeddingCount()).toBe(3);
  });

  test("incremental re-chunking prunes obsolete tail chunks", async () => {
    await note("kb/concepts/resize.md", "x".repeat(25));
    await ix.refreshStale(personaDir);
    await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 10,
    });
    expect(ix.allEmbeddings()).toHaveLength(3);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await note("kb/concepts/resize.md", "x".repeat(25));
    await ix.refreshStale(personaDir);
    const r = await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 20,
    });
    expect(r.totalChunks).toBe(2);
    expect(ix.allEmbeddings()).toHaveLength(2);
  });
});

describe("MemoryIndex.hybridSearch", () => {
  test("returns FTS-only results when no query vector is provided", async () => {
    await note("kb/concepts/A.md", "deye inverter");
    await ix.refreshStale(personaDir);
    const hits = ix.hybridSearch("deye", undefined);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("kb/concepts/A.md");
    expect(hits[0]?.ftsScore).toBeGreaterThan(0);
    expect(hits[0]?.vecScore).toBeUndefined();
  });

  test("merges FTS + vec via RRF when both provide hits", async () => {
    await note("kb/concepts/A.md", "alpha note about deye");
    await note("kb/concepts/B.md", "beta note about something else");
    await note("kb/concepts/C.md", "gamma totally unrelated");
    await ix.refreshStale(personaDir);
    await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 18_000,
    });

    // Build a query vector that matches A's embedding (same first char)
    const queryEmbed = await fakeEmbedder()("alpha query");
    if (!queryEmbed.ok) throw new Error("embed failed");

    const hits = ix.hybridSearch("alpha deye", queryEmbed.values, {
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    // First hit should have both FTS and vec scores merged
    const top = hits[0]!;
    expect(top.path).toBeDefined();
    expect(top.rrfScore).toBeGreaterThan(0);
  });

  test("respects scope when stored embeddings span memory + kb", async () => {
    await note("memory/decisions.md", "elevenlabs choice");
    await note("kb/concepts/Voice.md", "elevenlabs voice config");
    await ix.refreshStale(personaDir);
    await runEmbedJob({
      personaDir,
      index: ix,
      embedder: fakeEmbedder(),
      maxChunkChars: 18_000,
    });
    const queryEmbed = await fakeEmbedder()("elevenlabs anything");
    if (!queryEmbed.ok) throw new Error("embed failed");
    const memOnly = ix.hybridSearch("elevenlabs", queryEmbed.values, {
      scope: "memory",
    });
    expect(memOnly.every((h) => h.scope === "memory")).toBe(true);
  });
});

describe("defaultEmbedder", () => {
  test("returns undefined when provider is not gemini", () => {
    const e = defaultEmbedder({
      defaultPersona: "x",
      harnessIdleTimeoutMs: 1, harnessHardTimeoutMs: 1, harnessStartupTimeoutMs: 1,
      personasDir: "/tmp",
      memoryDbPath: "/tmp/m.sqlite",
      configPath: "/tmp/c.toml",
      harnesses: {
        chain: [],
        claude: { bin: "x", model: "y", fallbackModel: "" },
        pi: { bin: "x", maxPayloadBytes: 1 },
      },
      channels: {},
      embeddings: { provider: "none" },
      voice: { provider: "none" },
    });
    expect(e).toBeUndefined();
  });

  test("returns undefined when provider is gemini but apiKey is empty", () => {
    const e = defaultEmbedder({
      defaultPersona: "x",
      harnessIdleTimeoutMs: 1, harnessHardTimeoutMs: 1, harnessStartupTimeoutMs: 1,
      personasDir: "/tmp",
      memoryDbPath: "/tmp/m.sqlite",
      configPath: "/tmp/c.toml",
      harnesses: {
        chain: [],
        claude: { bin: "x", model: "y", fallbackModel: "" },
        pi: { bin: "x", maxPayloadBytes: 1 },
      },
      channels: {},
      voice: { provider: "none" },
      embeddings: {
        provider: "gemini",
        gemini: { apiKey: "", model: "g", dims: 1536 },
      },
    });
    expect(e).toBeUndefined();
  });
});

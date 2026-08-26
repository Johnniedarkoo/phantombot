import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runTurnEmbedJob } from "../src/lib/embedJob.ts";
import {
  embeddingSpaceForConfig,
  makeEmbeddingSpace,
} from "../src/lib/embeddingSpace.ts";
import { MemoryIndex, turnPath } from "../src/lib/memoryIndex.ts";

const geminiA = makeEmbeddingSpace({
  provider: "gemini",
  model: "model-a",
  dimensions: 4,
});
const legacyGemini = makeEmbeddingSpace({
  provider: "gemini",
  model: "gemini-embedding-001",
  dimensions: 1536,
});
const legacyGeminiWrongModel = makeEmbeddingSpace({
  provider: "gemini",
  model: "model-a",
  dimensions: 1536,
});
const geminiB = makeEmbeddingSpace({
  provider: "gemini",
  model: "model-b",
  dimensions: 4,
});
const openA = makeEmbeddingSpace({
  provider: "openai-compatible",
  model: "model-a",
  dimensions: 4,
  documentPrefix: "passage: ",
});
const openPrefixB = makeEmbeddingSpace({
  provider: "openai-compatible",
  model: "model-a",
  dimensions: 4,
  documentPrefix: "document: ",
});

const turn = {
  id: 1,
  persona: "phantom",
  conversation: "cli:default",
  role: "user" as const,
  text: "a historical turn",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  embeddable: true,
  source: "principal" as const,
  origin: "channel" as const,
};

describe("embedding-space identity", () => {
  test("same dimensions with a different model cannot reuse or retrieve old rows", () => {
    const ix = new MemoryIndex(new Database(":memory:"));
    try {
      ix.upsertEmbedding("kb/a.md", 0, new Float32Array([1, 0, 0, 0]), "sha", geminiA);
      expect(ix.embeddingSha("kb/a.md", 0, geminiB)).toBeUndefined();
      expect(ix.allEmbeddings(geminiB)).toHaveLength(0);
      expect(
        ix.hybridSearch("foreign", new Float32Array([1, 0, 0, 0]), {
          embeddingSpace: geminiB,
        }),
      ).toHaveLength(0);
    } finally {
      ix.close();
    }
  });

  test("same model with a different document prefix cannot reuse old rows", () => {
    const ix = new Database(":memory:");
    const index = new MemoryIndex(ix);
    index.upsertEmbedding("kb/a.md", 0, new Float32Array([1, 0, 0, 0]), "sha", openA);
    expect(index.embeddingSha("kb/a.md", 0, openPrefixB)).toBeUndefined();
    expect(index.allEmbeddings(openPrefixB)).toHaveLength(0);
    index.close();
  });

  test("same embedding space reuses the SHA, while query-prefix changes do not matter", () => {
    const ix = new Database(":memory:");
    const index = new MemoryIndex(ix);
    index.upsertEmbedding("kb/a.md", 0, new Float32Array([1, 0, 0, 0]), "sha", openA);
    const queryPrefixOnly = makeEmbeddingSpace({
      provider: "openai-compatible",
      model: "model-a",
      dimensions: 4,
      documentPrefix: "passage: ",
    });
    expect(queryPrefixOnly.fingerprint).toBe(openA.fingerprint);
    expect(index.embeddingSha("kb/a.md", 0, queryPrefixOnly)).toBe("sha");
    index.close();
  });

  test("legacy untagged rows are accepted only by the canonical Gemini default", () => {
    const ix = new Database(":memory:");
    const index = new MemoryIndex(ix);
    index.upsertEmbedding("kb/legacy.md", 0, new Float32Array([1, 0, 0, 0]), "sha");
    expect(index.allEmbeddings(legacyGemini)).toHaveLength(1);
    expect(index.allEmbeddings(legacyGeminiWrongModel)).toHaveLength(0);
    expect(index.allEmbeddings(openA)).toHaveLength(0);
    index.upsertTurn(turn, new Float32Array([1, 0, 0, 0]), "turn-sha");
    expect(index.turnEmbeddingSha(turnPath(turn), legacyGemini)).toBe("turn-sha");
    expect(index.turnEmbeddingSha(turnPath(turn), legacyGeminiWrongModel)).toBeUndefined();
    expect(index.turnsMissingEmbeddings("phantom", 10, legacyGeminiWrongModel)).toHaveLength(1);
    expect(
      index.hybridSearch("legacy", new Float32Array([1, 0]), {
        embeddingSpace: legacyGemini,
      }),
    ).toHaveLength(0);
    index.close();
  });

  test("tagged Gemini rows match only by exact fingerprint", () => {
    const ix = new Database(":memory:");
    const index = new MemoryIndex(ix);
    index.upsertEmbedding(
      "kb/tagged.md",
      0,
      new Float32Array([1, 0]),
      "sha",
      legacyGemini,
    );
    expect(index.allEmbeddings(legacyGemini)).toHaveLength(1);
    expect(index.allEmbeddings(legacyGeminiWrongModel)).toHaveLength(0);
    index.close();
  });

  test("compatible embedding count applies the same space predicate without counting foreign rows", () => {
    const ix = new Database(":memory:");
    const index = new MemoryIndex(ix);
    index.upsertEmbedding("kb/current.md", 0, new Float32Array([1, 0]), "a", legacyGemini);
    index.upsertEmbedding("kb/legacy.md", 0, new Float32Array([1, 0]), "b");
    index.upsertEmbedding("kb/foreign.md", 0, new Float32Array([1, 0]), "c", legacyGeminiWrongModel);
    index.upsertEmbedding("kb/open-current.md", 0, new Float32Array([1, 0]), "e", openA);
    index.upsertTurn(turn, new Float32Array([1, 0]), "d", legacyGemini);
    expect(index.embeddingCount(legacyGemini)).toBe(3);
    expect(index.embeddingCount(legacyGeminiWrongModel)).toBe(1);
    expect(index.embeddingCount(openA)).toBe(1);
    index.close();
  });

  test("a foreign-space turn is treated as needing a current-space embedding", async () => {
    const ix = new Database(":memory:");
    const index = new MemoryIndex(ix);
    index.upsertTurn(turn, new Float32Array([1, 0, 0, 0]), "same-text", geminiB);
    expect(index.turnEmbeddingSha(turnPath(turn), geminiA)).toBeUndefined();
    expect(index.turnsMissingEmbeddings("phantom", 10, geminiA)).toHaveLength(1);
    let calls = 0;
    const r = await runTurnEmbedJob({
      index,
      space: geminiA,
      embedder: Object.assign(async () => {
        calls++;
        return {
          ok: true as const,
          values: new Float32Array([0, 1, 0, 0]),
          dims: 4,
        };
      }, { space: geminiA }),
    });
    expect(calls).toBe(1);
    expect(r.embedded).toBe(1);
    expect(index.turnEmbeddingSha(turnPath(turn), geminiA)).toBeDefined();
  });

  test("config identity contains provider/model/dimensions and excludes query prefix", () => {
    const space = embeddingSpaceForConfig({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost/v1",
        model: "model-a",
        apiKey: "secret-a",
        dims: 4,
        queryPrefix: "query-a: ",
        documentPrefix: "passage: ",
      },
    });
    const changedQuery = embeddingSpaceForConfig({
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost/v1",
        model: "model-a",
        apiKey: "secret-b",
        dims: 4,
        queryPrefix: "query-b: ",
        documentPrefix: "passage: ",
      },
    });
    expect(space?.fingerprint).toBe(changedQuery?.fingerprint);
  });
});

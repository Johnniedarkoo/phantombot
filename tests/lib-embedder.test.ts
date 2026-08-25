import { describe, expect, test } from "bun:test";
import { resolveEmbedders } from "../src/lib/embedder.ts";

describe("resolveEmbedders", () => {
  test("none resolves no query or document provider", () => {
    expect(resolveEmbedders({ embeddings: { provider: "none" } } as never)).toEqual({});
  });

  test("openai-compatible applies query and document prefixes independently", async () => {
    const requests: Array<{ input: string; signal?: AbortSignal }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({
        input: JSON.parse(String(init?.body)).input,
        signal: init?.signal ?? undefined,
      });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const embedders = resolveEmbedders(
      {
        embeddings: {
          provider: "openai-compatible",
          openaiCompatible: {
            baseUrl: "http://localhost/v1",
            model: "m",
            apiKey: "",
            dims: 2,
            queryPrefix: "query: ",
            documentPrefix: "passage: ",
          },
        },
      } as never,
      { fetchImpl },
    );
    const signal = AbortSignal.timeout(1000);
    expect((await embedders.query!("where?", signal)).ok).toBe(true);
    expect((await embedders.document!("fact", signal)).ok).toBe(true);
    expect(requests.map((r) => r.input)).toEqual(["query: where?", "passage: fact"]);
    expect(requests.every((r) => r.signal === signal)).toBe(true);
  });
});

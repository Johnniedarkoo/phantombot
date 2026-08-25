import { describe, expect, test } from "bun:test";
import { openaiCompatibleEmbed } from "../src/lib/openaiCompatibleEmbed.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("openaiCompatibleEmbed", () => {
  test("posts the standard request and returns Float32Array", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const r = await openaiCompatibleEmbed("hello", {
      baseUrl: "http://127.0.0.1:8082/v1/",
      model: "small-embed",
      fetchImpl: (async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return response({ data: [{ embedding: [0.1, -0.2] }] });
      }) as typeof fetch,
      dims: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seenUrl).toBe("http://127.0.0.1:8082/v1/embeddings");
    expect(seenInit?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      model: "small-embed",
      input: "hello",
      encoding_format: "float",
    });
    expect(r.values).toBeInstanceOf(Float32Array);
    expect(r.values[0]).toBeCloseTo(0.1, 6);
    expect(r.values[1]).toBeCloseTo(-0.2, 6);
    expect(r.dims).toBe(2);
  });

  test("sends authorization only for a nonempty key", async () => {
    let headers: Headers | Record<string, string> | undefined;
    const r = await openaiCompatibleEmbed("x", {
      baseUrl: "http://localhost/v1",
      model: "m",
      apiKey: " secret ",
      fetchImpl: (async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return response({ data: [{ embedding: [1] }] });
      }) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
  });

  test("rejects HTTP, malformed, missing, invalid, and mismatched responses", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ error: { message: "down" } }, 503, "down"],
      ["not json", 200, "non-JSON"],
      [{ data: [] }, 200, "no embedding"],
      [{ data: [{ embedding: [1, Number.NaN] }] }, 200, "non-numeric"],
      [{ data: [{ embedding: [1, 2] }] }, 200, "dimension mismatch"],
    ];
    for (const [body, status, expected] of cases) {
      const fetchImpl = (async () => {
        if (body === "not json") {
          return new Response("not json", { status });
        }
        return response(body, status);
      }) as unknown as typeof fetch;
      const r = await openaiCompatibleEmbed("x", {
        baseUrl: "http://localhost/v1",
        model: "m",
        dims: expected === "dimension mismatch" ? 3 : undefined,
        fetchImpl,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(expected);
    }
  });

  test("passes AbortSignal through to fetch", async () => {
    const signal = AbortSignal.timeout(1000);
    let seen: AbortSignal | undefined;
    await openaiCompatibleEmbed("x", {
      baseUrl: "http://localhost/v1",
      model: "m",
      signal,
      fetchImpl: (async (_url, init) => {
        seen = init?.signal ?? undefined;
        return response({ data: [{ embedding: [1] }] });
      }) as typeof fetch,
    });
    expect(seen).toBe(signal);
  });
});

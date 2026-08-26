import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEmbeddingPreflight } from "../src/lib/embedJob.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";

let workdir: string;
let personaDir: string;
let index: MemoryIndex;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-emb-preflight-"));
  personaDir = join(workdir, "persona");
  await mkdir(join(personaDir, "kb", "concepts"), { recursive: true });
  index = await MemoryIndex.open(":memory:");
});

afterEach(async () => {
  index.close();
  await rm(workdir, { recursive: true, force: true });
});

async function arrangeStaleIndexedNoteAndFreshDiskNote(): Promise<void> {
  const stalePath = join(personaDir, "kb", "concepts", "A.md");
  await writeFile(stalePath, "stale alpha");
  await index.refreshStale(personaDir);
  await unlink(stalePath);
  await writeFile(join(personaDir, "kb", "concepts", "B.md"), "fresh beta");
}

describe("runEmbeddingPreflight stale index rows", () => {
  test("skips a deleted indexed note and probes the next readable document", async () => {
    await arrangeStaleIndexedNoteAndFreshDiskNote();
    const calls: string[] = [];

    const result = await runEmbeddingPreflight({
      personaDir,
      index,
      maxChunkChars: 1000,
      embedder: async (text) => {
        calls.push(text);
        return {
          ok: true as const,
          values: new Float32Array([1, 0]),
          dims: 2,
        };
      },
    });

    expect(result).toEqual({ ok: true, path: "kb/concepts/B.md" });
    expect(calls).toEqual(["fresh beta"]);
  });

  test("still fails preflight when the provider rejects the readable probe", async () => {
    await arrangeStaleIndexedNoteAndFreshDiskNote();

    const result = await runEmbeddingPreflight({
      personaDir,
      index,
      maxChunkChars: 1000,
      embedder: async () => ({
        ok: false as const,
        error: "endpoint down",
      }),
    });

    expect(result).toEqual({
      ok: false,
      path: "kb/concepts/B.md",
      error: "endpoint down",
    });
  });
});

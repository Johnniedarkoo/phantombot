/**
 * runTurn `publicContext` (agent-room): the prompt carries the persona's
 * identity only — no MEMORY.md, tools hints, daily journal, retrieval or
 * durable facts — and `toolsMode: "none"` reaches the harness.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/orchestrator/turn.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

let agentDir: string;
let memory: MemoryStore;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "phantombot-public-"));
  await writeFile(join(agentDir, "BOOT.md"), "# I am Phantom", "utf8");
  await writeFile(join(agentDir, "MEMORY.md"), "MARKER-PRIVATE-MEMORY", "utf8");
  await writeFile(join(agentDir, "tools.md"), "MARKER-PRIVATE-TOOLS", "utf8");
  await mkdir(join(agentDir, "memory"), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  await writeFile(join(agentDir, "memory", `${date}.md`), "- MARKER-PRIVATE-JOURNAL", "utf8");
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(agentDir, { recursive: true, force: true });
});

function capturing(): { harness: Harness; get: () => HarnessRequest | undefined } {
  let captured: HarnessRequest | undefined;
  const harness: Harness = {
    id: "fake",
    available: async () => true,
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      captured = req;
      yield { type: "done", finalText: "ok" };
    },
  };
  return { harness, get: () => captured };
}

async function drain(iter: AsyncIterable<HarnessChunk>): Promise<void> {
  for await (const _ of iter) {
    // consume
  }
}

describe("runTurn — publicContext", () => {
  const calls: string[] = [];
  const hooks = () => ({
    retrieve: async () => {
      calls.push("retrieve");
      return "MARKER-PRIVATE-RETRIEVED";
    },
    pullFacts: async () => {
      calls.push("pullFacts");
      return "MARKER-PRIVATE-FACT";
    },
    extractFacts: async () => {
      calls.push("extractFacts");
    },
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const base = () => ({
    persona: "phantom",
    conversation: "agentroom:friends",
    userMessage: "@phantom hi",
    agentDir,
    workingDir: agentDir,
    memory,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 5_000,
    trusted: true, // skip the screen so only publicContext varies
    ...hooks(),
  });

  test("control: a normal turn carries memory, tools hints, journal, retrieval and facts", async () => {
    const { harness, get } = capturing();
    await drain(runTurn({ ...base(), harnesses: [harness] }));
    const prompt = get()?.systemPrompt ?? "";
    for (const marker of ["MEMORY", "TOOLS", "JOURNAL", "RETRIEVED", "FACT"]) {
      expect(prompt).toContain(`MARKER-PRIVATE-${marker}`);
    }
  });

  test("public context keeps identity and drops every private source", async () => {
    const { harness, get } = capturing();
    await drain(
      runTurn({
        ...base(),
        harnesses: [harness],
        publicContext: true,
        noHistory: true,
        toolsMode: "none",
        mcpMode: "none",
      }),
    );
    const req = get();
    const prompt = req?.systemPrompt ?? "";
    expect(prompt).toContain("# I am Phantom");
    expect(prompt).not.toContain("MARKER-PRIVATE");
    expect(calls).toEqual([]);
    expect(req?.toolsMode).toBe("none");
    expect(req?.mcpMode).toBe("none");
    expect(await memory.recentTurns("phantom", "agentroom:friends", 10)).toEqual([]);
  });
});

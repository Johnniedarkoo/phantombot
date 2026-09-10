import { describe, expect, test } from "bun:test";

import { McpHub } from "../src/mcp/hub.ts";
import type { McpToolInfo } from "../src/mcp/client.ts";

const fakeTools: Record<string, McpToolInfo[]> = {
  gmail: [
    { name: "list_inbox_threads", description: "List inbox metadata" },
    { name: "get_thread", description: "Read one thread" },
  ],
  calendar: [{ name: "list_events", description: "List calendar events" }],
};

function fakeHub(): McpHub {
  const hub = new McpHub(
    {
      mcpServers: {
        gmail: { transport: "stdio", command: "unused" },
        calendar: { transport: "stdio", command: "unused" },
      },
    },
    { get: () => undefined, set: () => {}, unset: () => {} },
  );
  (hub as any).tools = async (serverId: string) => fakeTools[serverId] ?? [];
  return hub;
}

describe("McpHub.search", () => {
  test("an exact server id returns only that server's tools", async () => {
    const result = await fakeHub().search("gmail");
    expect(result.errors).toEqual({});
    expect(result.hits.map((hit) => hit.qualifiedName)).toEqual([
      "gmail__list_inbox_threads",
      "gmail__get_thread",
    ]);
  });

  test("a capability query still searches tool names and descriptions", async () => {
    const result = await fakeHub().search("inbox");
    expect(result.hits.map((hit) => hit.qualifiedName)).toEqual([
      "gmail__list_inbox_threads",
    ]);
  });
});

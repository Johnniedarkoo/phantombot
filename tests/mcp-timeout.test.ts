import { describe, expect, test } from "bun:test";

import {
  MCP_REQUEST_TIMEOUT_CODE,
  McpRequestTimeoutError,
} from "../src/mcp/client.ts";

describe("MCP request timeout context", () => {
  test("adds server/tool/deadline context while preserving SDK code and data", () => {
    const cause = { code: MCP_REQUEST_TIMEOUT_CODE, data: { timeout: 60_000 } };
    const error = new McpRequestTimeoutError("gmail", "get_inbox_with_threads", 60_012, 60_000, cause);

    expect(error.message).toBe("gmail/get_inbox_with_threads timed out after 60s (MCP RequestTimeout)");
    expect(error.code).toBe(-32001);
    expect(error.data).toEqual({ timeout: 60_000 });
    expect(error.cause).toBe(cause);
    expect(error.elapsedMs).toBe(60_012);
  });
});

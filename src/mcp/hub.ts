/**
 * Connection hub — one shared set of upstream MCP connections + one token store
 * behind BOTH faces of the MCP surface (the `phantombot mcp` CLI and the
 * loopback proxy). This is the "same connections, same vault tokens, one
 * registry behind both" guarantee from the design.
 *
 * Connections are opened lazily (first time a server is searched/described/
 * called) and cached for the hub's lifetime. `search` and `describe` power the
 * lazy-discovery model: nothing is loaded until a task actually reaches for it.
 */

import type { Vault } from "../lib/vault.ts";
import { log } from "../lib/logger.ts";
import {
  callServerTool,
  connectServer,
  McpRequestTimeoutError,
  type ConnectOptions,
  listServerTools,
  type McpConnection,
  type McpToolInfo,
} from "./client.ts";
import { type McpRegistry, type McpServerEntry } from "./registry.ts";

/** A tool hit, namespaced by server so provenance and collisions are obvious. */
export interface McpToolHit {
  server: string;
  /** Namespaced id, `<server>__<tool>` — how Claude/Codex will see it. */
  qualifiedName: string;
  tool: McpToolInfo;
}

/** Split a namespaced `<server>__<tool>` id, or return undefined if unqualified. */
export function splitQualified(qualified: string): { server: string; tool: string } | undefined {
  const idx = qualified.indexOf("__");
  if (idx <= 0) return undefined;
  return { server: qualified.slice(0, idx), tool: qualified.slice(idx + 2) };
}

/** Join a server id + tool name into the namespaced form. */
export function qualify(server: string, tool: string): string {
  return `${server}__${tool}`;
}

export class McpHub {
  private readonly conns = new Map<string, McpConnection>();
  private readonly toolCache = new Map<string, McpToolInfo[]>();

  constructor(
    private readonly registry: McpRegistry,
    private readonly vault: Pick<Vault, "get" | "set" | "unset">,
    private readonly connectOpts?: Partial<ConnectOptions>,
  ) {}

  /** Registered server ids. */
  serverIds(): string[] {
    return Object.keys(this.registry.mcpServers);
  }

  entry(serverId: string): McpServerEntry | undefined {
    return this.registry.mcpServers[serverId];
  }

  /** Open (or reuse) a connection to a server. Throws the actionable client errors. */
  async connection(serverId: string): Promise<McpConnection> {
    const cached = this.conns.get(serverId);
    if (cached) return cached;
    const entry = this.registry.mcpServers[serverId];
    if (!entry) throw new Error(`no such MCP server: '${serverId}'`);
    const conn = await connectServer(serverId, entry, {
      vault: this.vault,
      ...this.connectOpts,
    });
    this.conns.set(serverId, conn);
    return conn;
  }

  /** List one server's tools (cached per hub lifetime). */
  async tools(serverId: string): Promise<McpToolInfo[]> {
    const cached = this.toolCache.get(serverId);
    if (cached) return cached;
    const conn = await this.connection(serverId);
    const startedAt = Date.now();
    let tools: McpToolInfo[];
    try {
      tools = await listServerTools(conn.client);
    } catch (err) {
      throw this.withTimeoutContext(serverId, "tools/list", startedAt, err);
    }
    this.toolCache.set(serverId, tools);
    return tools;
  }

  /**
   * Lazy tool discovery across registered servers. An exact server-id query is
   * server-targeted and returns that server's tools; other queries are
   * substring matches over server id + tool name + description. Servers that
   * fail to connect are reported in `errors` rather than aborting the whole
   * search — one broken server must not blind the agent to the others.
   */
  async search(query: string): Promise<{ hits: McpToolHit[]; errors: Record<string, string> }> {
    const q = query.trim().toLowerCase();
    const hits: McpToolHit[] = [];
    const errors: Record<string, string> = {};
    const registeredServerIds = this.serverIds();
    const exactServerId = registeredServerIds.find((id) => id.toLowerCase() === q);
    const serverIds = exactServerId ? [exactServerId] : registeredServerIds;
    for (const serverId of serverIds) {
      let tools: McpToolInfo[];
      try {
        tools = await this.tools(serverId);
      } catch (err) {
        errors[serverId] = (err as Error).message;
        continue;
      }
      for (const tool of tools) {
        const hay = `${serverId} ${tool.name} ${tool.description ?? ""}`.toLowerCase();
        if (exactServerId || q.length === 0 || hay.includes(q)) {
          hits.push({ server: serverId, qualifiedName: qualify(serverId, tool.name), tool });
        }
      }
    }
    return { hits, errors };
  }

  /** Call a tool by server + (unqualified) tool name. */
  async call(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = await this.connection(serverId);
    const startedAt = Date.now();
    try {
      return await callServerTool(conn.client, toolName, args);
    } catch (err) {
      throw this.withTimeoutContext(serverId, toolName, startedAt, err);
    }
  }

  private withTimeoutContext(
    serverId: string,
    operation: string,
    startedAt: number,
    err: unknown,
  ): unknown {
    if (!isRequestTimeout(err)) return err;
    const elapsedMs = Date.now() - startedAt;
    const timeoutMs = requestTimeoutMs(err);
    log.warn("mcp request timeout", {
      serverId,
      operation,
      elapsedMs,
      deadlineMs: timeoutMs,
      code: -32001,
    });
    return new McpRequestTimeoutError(serverId, operation, elapsedMs, timeoutMs, err);
  }

  /** Close every open connection. */
  async close(): Promise<void> {
    for (const conn of this.conns.values()) {
      try {
        await conn.close();
      } catch {
        /* best effort */
      }
    }
    this.conns.clear();
    this.toolCache.clear();
  }
}

function isRequestTimeout(err: unknown): boolean {
  return isRecord(err) && err.code === -32001;
}

function requestTimeoutMs(err: unknown): number {
  if (!isRecord(err)) return 60_000;
  const data = err.data;
  if (isRecord(data) && typeof data.timeout === "number" && Number.isFinite(data.timeout)) {
    return data.timeout;
  }
  return 60_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

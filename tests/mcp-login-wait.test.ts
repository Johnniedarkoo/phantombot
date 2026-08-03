/**
 * Loopback-wait regression guard for `phantombot mcp login`.
 *
 * The bug this locks down: with no `--wait`, `beginLogin` printed the auth URL
 * and then IMMEDIATELY closed the loopback listener (its `finally`), so the
 * browser's redirect to 127.0.0.1:<port> hit a dead port
 * (ERR_CONNECTION_REFUSED) — even when browser and listener were on the same
 * host. The fix holds the listener open (default 180s) so the redirect lands
 * and the code is exchanged automatically.
 *
 * Both layers are covered:
 *   - beginLogin: the listener survives after the URL is issued and completes
 *     when the redirect arrives during the wait window (and onWaiting fires so
 *     the manual fallback is offered immediately, not only on timeout).
 *   - runMcpLogin (CLI): with NO --wait it applies the default wait and
 *     auto-completes when the browser reaches the loopback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LOGIN_WAIT_MS, runMcpAdd, runMcpLogin } from "../src/cli/mcp.ts";
import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import { toClientInformation } from "../src/mcp/oauthClient.ts";
import { writeStaticClient } from "../src/mcp/authProvider.ts";
import { beginLogin } from "../src/mcp/login.ts";
import type { McpServerEntry } from "../src/mcp/registry.ts";
import { generateSecretKey } from "nostr-tools/pure";
import { rmrf } from "./fixtures/rmrf.ts";

/**
 * A minimal OAuth authorization server with NO registration endpoint. Combined
 * with a pre-registered static client this lets `auth()` run without DCR, so
 * these tests exercise the loopback path, not registration.
 */
function startFixtureAuthServer() {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const origin = url.origin;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return new Response("not found", { status: 404 });
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration"
      ) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        return Response.json({
          access_token: "access-123",
          token_type: "Bearer",
          refresh_token: "refresh-123",
          expires_in: 3600,
        });
      }
      return new Response("ok");
    },
  });
  return { url: `${server.url.origin}/mcp`, close: () => server.stop(true) };
}

async function pollFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("pollFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("beginLogin — loopback listener survives until the redirect", () => {
  let workdir: string;
  let vault: Vault;
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "phantombot-login-wait-"));
    vault = openVaultWithSecret(workdir, generateSecretKey());
  });
  afterEach(async () => {
    vault.close();
    await rmrf(workdir);
  });

  test("redirect delivered during the wait window completes the exchange", async () => {
    const fx = startFixtureAuthServer();
    const tokenRef = "MCP_WAIT_OAUTH";
    try {
      // Pre-registered client → skip DCR, isolate the loopback behaviour.
      writeStaticClient(vault, tokenRef, toClientInformation({ clientId: "cid", clientSecret: "sec" }));
      const entry: McpServerEntry = { transport: "http", url: fx.url, auth: { type: "oauth", tokenRef } };

      let onWaitingFired = false;
      const result = await beginLogin("wsrv", entry, vault, {
        waitForRedirectMs: 5000,
        onWaiting: ({ redirectUrl }) => {
          onWaitingFired = true;
          // Simulate the browser redirect AFTER the URL was issued — the listener
          // must still be alive here. Fire-and-forget; beginLogin's waitForCode
          // resolves from it.
          void fetch(`${redirectUrl}?code=the-code`);
        },
      });

      expect(onWaitingFired).toBe(true); // manual fallback offered while waiting
      expect(result.status).toBe("authorized");
      expect(vault.get(tokenRef)).toBeDefined(); // tokens landed
    } finally {
      fx.close();
    }
  }, 15_000);

  test("waitForRedirectMs=0 returns pending without waiting (explicit opt-out)", async () => {
    const tokenRef = "MCP_NOWAIT_OAUTH";
    const fx = startFixtureAuthServer();
    try {
      writeStaticClient(vault, tokenRef, toClientInformation({ clientId: "cid" }));
      const entry: McpServerEntry = { transport: "http", url: fx.url, auth: { type: "oauth", tokenRef } };
      const result = await beginLogin("nsrv", entry, vault, { waitForRedirectMs: 0 });
      expect(result.status).toBe("pending");
      if (result.status === "pending") {
        expect(result.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      }
    } finally {
      fx.close();
    }
  }, 15_000);
});

describe("runMcpLogin (CLI) — default wait auto-completes", () => {
  let workdir: string;
  const savedEnv = { ...process.env };
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "phantombot-cli-login-wait-"));
    process.env.PHANTOMBOT_PERSONAS_DIR = workdir;
    process.env.PHANTOMBOT_DEFAULT_PERSONA = "tester";
    process.env.PHANTOMBOT_PERSONA = "tester";
  });
  afterEach(async () => {
    process.env = { ...savedEnv };
    await rmrf(workdir);
  });

  test("the default wait is a sane, non-zero window", () => {
    expect(DEFAULT_LOGIN_WAIT_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("no --wait: holds the listener, browser reaches it, login authorizes", async () => {
    const fx = startFixtureAuthServer();
    try {
      // Register the oauth server (pointing at the fixture) with a pre-registered
      // client so DCR is skipped.
      const add = await runMcpAdd({
        id: "gmail",
        http: true,
        url: fx.url,
        oauth: true,
        tokenRef: "MCP_GMAIL_OAUTH",
        clientId: "cid",
        clientSecret: "sec",
        out: { write: () => true },
        err: { write: () => true },
      });
      expect(add).toBe(0);

      const chunks: string[] = [];
      const out = { write: (s: string | Uint8Array) => (chunks.push(String(s)), true) };
      // Do NOT pass waitMs — prove the default keeps the listener open.
      const p = runMcpLogin({ id: "gmail", out, err: out });

      // Once the login prints the redirect URL, the listener is live — hit it.
      const redirectUrl = await pollFor(() => {
        const m = chunks.join("").match(/--redirect-url (\S+)/);
        return m?.[1];
      });
      await fetch(`${redirectUrl}?code=the-code`);

      expect(await p).toBe(0);
      expect(chunks.join("")).toContain("authorized");
    } finally {
      fx.close();
    }
  }, 20_000);
});

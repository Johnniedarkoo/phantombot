/**
 * Tests for withPersonaEnv — the only thing envBootstrap still does.
 *
 * The preloadEnvFiles/reloadEnvFiles suites that used to live here are GONE
 * with the functions themselves (#452): phantombot no longer sources a
 * plaintext .env at startup or before a harness spawn. Credentials reach a
 * turn only through the encrypted persona vault, and the guard that no new
 * runtime .env read path appears lives in tests/lib-envFile.test.ts.
 */

import { describe, expect, test } from "bun:test";

import { withPersonaEnv } from "../src/lib/envBootstrap.ts";

describe("withPersonaEnv", () => {
  test("sets PHANTOMBOT_PERSONA and PHANTOMBOT_CONVERSATION to the turn context", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const out = withPersonaEnv(base, "burt", "telegram:42");
    expect(out.PHANTOMBOT_PERSONA).toBe("burt");
    expect(out.PHANTOMBOT_CONVERSATION).toBe("telegram:42");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("does not mutate the input env (copy-on-write)", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const out = withPersonaEnv(base, "robbie");
    expect(out).not.toBe(base);
    expect(base.PHANTOMBOT_PERSONA).toBeUndefined();
    expect(base.PHANTOMBOT_CONVERSATION).toBeUndefined();
  });

  test("sets only conversation when persona is undefined", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const out = withPersonaEnv(base, undefined, "telegram:42");
    expect(out).not.toBe(base);
    expect(out.PHANTOMBOT_PERSONA).toBeUndefined();
    expect(out.PHANTOMBOT_CONVERSATION).toBe("telegram:42");
  });

  test("returns the base untouched when persona and conversation are empty", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(withPersonaEnv(base, "")).toBe(base);
  });
});

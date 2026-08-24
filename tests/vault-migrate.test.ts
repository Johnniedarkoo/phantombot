/**
 * Plaintext → encrypted-vault migration (PR #253, reworked in #452). The import
 * is now ONE-WAY and NON-DESTRUCTIVE: the plaintext file survives for rollback
 * and a sibling `<file>.migrated-to-vault` stamp is what makes the import
 * happen exactly once.
 *
 * Covers:
 *   - ~/.env → FANNED OUT into every persona's vault (default AND non-default),
 *     decryptable, file KEPT and stamped,
 *   - central .env → FANNED OUT into every persona's vault,
 *   - COLLISION: a ~/.env value WINS over the central one, in every persona,
 *   - IDEMPOTENCY: a stamped file is not re-imported, so a later `vault set`
 *     is never stomped back to the stale plaintext value,
 *   - hidden/non-persona dirs are NOT sprayed with an identity + secrets.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmrf } from "./fixtures/rmrf.ts";
import type { Config } from "../src/config.ts";
import { personaDir } from "../src/config.ts";
import { openPersonaVault as _openPersonaVault } from "../src/lib/vault.ts";
import { openPersonaVault, vaultPath } from "../src/lib/vault.ts";
import {
  migratePlaintextToVault,
  migrationStampPath,
} from "../src/lib/vaultMigrate.ts";

/**
 * Write a legacy plaintext env file by hand. phantombot itself no longer has a
 * .env writer (#452) — the fixture has to produce the bytes an OLDER build
 * left behind, which is exactly what the migration must still be able to read.
 */
async function writeLegacyEnv(
  path: string,
  vars: Record<string, string>,
): Promise<void> {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${/[\s#"'\\]/.test(v) ? JSON.stringify(v) : v}`)
    .join("\n");
  await writeFile(path, body + "\n", { encoding: "utf8", mode: 0o600 });
}

let workdir: string;
let userEnv: string;
let centralEnv: string;
let personasDir: string;
let savedUserEnvVar: string | undefined;
let savedCentralEnvVar: string | undefined;

/** Minimal Config — the migrate path only reads defaultPersona + personasDir. */
function cfg(): Config {
  return { defaultPersona: "robbie", personasDir } as unknown as Config;
}

/** Decrypt one key out of a persona's vault. */
async function readVault(persona: string, name: string): Promise<string | undefined> {
  const v = await openPersonaVault(personaDir(cfg(), persona));
  try {
    return v.get(name);
  } finally {
    v.close();
  }
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-migrate-"));
  userEnv = join(workdir, "user.env");
  centralEnv = join(workdir, "central.env");
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });

  savedUserEnvVar = process.env.PHANTOMBOT_USER_ENV_FILE;
  savedCentralEnvVar = process.env.PHANTOMBOT_ENV_FILE;
  process.env.PHANTOMBOT_USER_ENV_FILE = userEnv;
  process.env.PHANTOMBOT_ENV_FILE = centralEnv;
});

afterEach(async () => {
  if (savedUserEnvVar === undefined) delete process.env.PHANTOMBOT_USER_ENV_FILE;
  else process.env.PHANTOMBOT_USER_ENV_FILE = savedUserEnvVar;
  if (savedCentralEnvVar === undefined) delete process.env.PHANTOMBOT_ENV_FILE;
  else process.env.PHANTOMBOT_ENV_FILE = savedCentralEnvVar;
  // rmrf retries on Windows EBUSY (bun:sqlite handles linger briefly after
  // close()). No-op-fast on POSIX. See fixtures/rmrf.
  await rmrf(workdir);
});

describe("migratePlaintextToVault", () => {
  test("~/.env migrates into the default persona's vault and is stamped, not deleted", async () => {
    await writeLegacyEnv(userEnv, { GITHUB_TOKEN: "ghp_local", API_KEY: "abc123" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("robbie", "GITHUB_TOKEN")).toBe("ghp_local");
    expect(await readVault("robbie", "API_KEY")).toBe("abc123");
    // Kept for rollback, and stamped so the next startup skips it.
    expect(existsSync(userEnv)).toBe(true);
    expect(existsSync(migrationStampPath(userEnv))).toBe(true);
  });

  test("~/.env fans out into NON-default personas too (Lena/Kai keep their creds)", async () => {
    // Pre-create non-default persona dirs so the fan-out reaches them.
    await mkdir(join(personasDir, "lena"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeLegacyEnv(userEnv, { GITHUB_TOKEN: "ghp_shared" });

    await migratePlaintextToVault(cfg());

    // Every persona — not just the default — must have the ~/.env secret.
    expect(await readVault("robbie", "GITHUB_TOKEN")).toBe("ghp_shared");
    expect(await readVault("lena", "GITHUB_TOKEN")).toBe("ghp_shared");
    expect(await readVault("kai", "GITHUB_TOKEN")).toBe("ghp_shared");
    expect(existsSync(migrationStampPath(userEnv))).toBe(true); // stamped only after all read back
  });

  test("collision: ~/.env value wins over central in a NON-default persona", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeLegacyEnv(userEnv, { SHARED: "local-wins" });
    await writeLegacyEnv(centralEnv, { SHARED: "central-value" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("kai", "SHARED")).toBe("local-wins");
  });

  test("central .env fans out into EVERY persona's vault", async () => {
    // Pre-create two persona dirs so the fan-out reaches both.
    await mkdir(join(personasDir, "lena"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeLegacyEnv(centralEnv, { TTS_KEY: "shared-tts" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("robbie", "TTS_KEY")).toBe("shared-tts");
    expect(await readVault("lena", "TTS_KEY")).toBe("shared-tts");
    expect(await readVault("kai", "TTS_KEY")).toBe("shared-tts");
    expect(existsSync(centralEnv)).toBe(true);
    expect(existsSync(migrationStampPath(centralEnv))).toBe(true);
  });

  test("collision: a persona-local ~/.env value wins over the central one", async () => {
    await writeLegacyEnv(userEnv, { SHARED: "local-wins" });
    await writeLegacyEnv(centralEnv, { SHARED: "central-value", ONLY_CENTRAL: "x" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("robbie", "SHARED")).toBe("local-wins");
    expect(await readVault("robbie", "ONLY_CENTRAL")).toBe("x");
  });

  test("idempotent: a re-run over a stamped file is a clean no-op", async () => {
    await writeLegacyEnv(userEnv, { K: "v" });
    await migratePlaintextToVault(cfg());
    expect(existsSync(migrationStampPath(userEnv))).toBe(true);

    // Second run must not throw and must leave the vault value intact.
    await migratePlaintextToVault(cfg());
    expect(await readVault("robbie", "K")).toBe("v");
  });

  test("a stamped file is NOT re-imported, so a later vault rotation survives a restart", async () => {
    // This is the whole reason the stamp exists. The plaintext file is kept
    // now, so without the stamp every startup would re-import it and silently
    // undo any `phantombot vault set` made since.
    await writeLegacyEnv(userEnv, { API_KEY: "stale-plaintext" });
    await migratePlaintextToVault(cfg());
    expect(await readVault("robbie", "API_KEY")).toBe("stale-plaintext");

    const vault = await openPersonaVault(personaDir(cfg(), "robbie"));
    try {
      vault.set("API_KEY", "rotated-in-vault");
    } finally {
      vault.close();
    }

    await migratePlaintextToVault(cfg()); // next startup

    expect(await readVault("robbie", "API_KEY")).toBe("rotated-in-vault");
  });

  test("an UNSTAMPED file is retried, so a partial first run still completes", async () => {
    await writeLegacyEnv(userEnv, { K: "v" });
    await migratePlaintextToVault(cfg());
    // Simulate a first run that wrote the vault but died before stamping.
    await rmrf(migrationStampPath(userEnv));

    await mkdir(join(personasDir, "lena"), { recursive: true });
    await migratePlaintextToVault(cfg());

    expect(await readVault("lena", "K")).toBe("v");
    expect(existsSync(migrationStampPath(userEnv))).toBe(true);
  });

  test("hidden/non-persona dirs are not sprayed with an identity or vault", async () => {
    await mkdir(join(personasDir, ".git"), { recursive: true });
    await writeLegacyEnv(centralEnv, { TTS_KEY: "shared" });

    await migratePlaintextToVault(cfg());

    // The default persona got it; the hidden dir did NOT get a vault.
    expect(await readVault("robbie", "TTS_KEY")).toBe("shared");
    expect(existsSync(vaultPath(join(personasDir, ".git")))).toBe(false);
    expect(existsSync(join(personasDir, ".git", "identity.json"))).toBe(false);
  });

  test("no plaintext files present → nothing happens, no throw", async () => {
    await migratePlaintextToVault(cfg());
    // default persona vault may exist but is empty of these keys.
    expect(await readVault("robbie", "ANYTHING")).toBeUndefined();
  });
});

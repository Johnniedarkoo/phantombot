/**
 * Auto-migration from the pre-#435 host-global layout.
 *
 * This is the code path every existing install runs exactly once, unattended,
 * on the first startup after the upgrade — so the properties under test are
 * "an unchanged box behaves identically afterwards" and "nothing is destroyed
 * if it goes wrong", not just "files moved".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateHostLayout,
  needsMigration,
  stripGlobalKeys,
} from "../src/lib/hostLayoutMigrate.ts";

const ENV_KEYS = [
  "PHANTOMBOT_PERSONA",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_GLOBAL_CONFIG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];
const SAVED: Record<string, string | undefined> = {};

let workdir: string;
let oldConfigDir: string;
let oldDataDir: string;
let oldStateDir: string;
let personasDir: string;

const HOST_CONFIG = `# my hand-written config
default_persona = "lena"
update_channel = "preview"

[channels.telegram]
token = "shared-token"

[harnesses]
chain = ["claude", "pi"]

[harnesses.personas.kai]
chain = ["pi"]
`;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-migrate-"));
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  process.env.XDG_CONFIG_HOME = join(workdir, "config");
  process.env.XDG_DATA_HOME = join(workdir, "data");
  process.env.XDG_STATE_HOME = join(workdir, "state");

  oldConfigDir = join(workdir, "config", "phantombot");
  oldDataDir = join(workdir, "data", "phantombot");
  oldStateDir = join(workdir, "state", "phantombot");
  personasDir = join(oldDataDir, "personas");
  await mkdir(join(personasDir, "lena"), { recursive: true });
  await mkdir(join(personasDir, "kai"), { recursive: true });
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  await rm(workdir, { recursive: true, force: true });
});

async function writeOldLayout(): Promise<void> {
  await mkdir(oldConfigDir, { recursive: true });
  await writeFile(join(oldConfigDir, "config.toml"), HOST_CONFIG, "utf8");
  await writeFile(join(oldConfigDir, ".env"), "TTS_KEY=secret\n", "utf8");
  await writeFile(
    join(oldDataDir, "state.json"),
    JSON.stringify({ default_persona: "lena", harness_bins: { pi: "/opt/pi" } }),
    "utf8",
  );
  await writeFile(join(oldDataDir, "memory.sqlite"), "DB", "utf8");
  await mkdir(join(oldDataDir, "memory-index"), { recursive: true });
  await writeFile(join(oldDataDir, "memory-index", "lena.sqlite"), "LENA", "utf8");
  await writeFile(join(oldDataDir, "memory-index", "kai.sqlite"), "KAI", "utf8");
  await mkdir(oldStateDir, { recursive: true });
  await writeFile(join(oldStateDir, "heartbeat.last-fired"), "ISO=x runs=1\n", "utf8");
}

describe("stripGlobalKeys", () => {
  test("removes only the global top-level keys, keeping comments", () => {
    const out = stripGlobalKeys(HOST_CONFIG);
    expect(out).toContain("# my hand-written config");
    expect(out).not.toContain("default_persona");
    expect(out).not.toContain("update_channel");
    expect(out).toContain('token = "shared-token"');
  });

  test("a same-named key INSIDE a table is left alone", () => {
    // `[x] memory_db = ...` is somebody else's key, not ours to delete.
    const out = stripGlobalKeys('[some.table]\nmemory_db = "keep me"\n');
    expect(out).toContain('memory_db = "keep me"');
  });
});

describe("migrateHostLayout", () => {
  test("no old layout → no-op, and needsMigration says so", () => {
    expect(needsMigration()).toBe(false);
    const report = migrateHostLayout();
    expect(report.migrated).toBe(false);
    expect(report.archived).toEqual([]);
  });

  test("every persona gets the host config verbatim, minus the global keys", async () => {
    await writeOldLayout();
    const report = migrateHostLayout();
    expect(report.personas.sort()).toEqual(["kai", "lena"]);

    for (const persona of ["lena", "kai"]) {
      const text = await readFile(join(personasDir, persona, "config.toml"), "utf8");
      // Verbatim is the point: a re-serialized copy could quietly change
      // behaviour, and the per-persona override tables still resolve because
      // the loader reads them by persona name.
      expect(text).toContain('token = "shared-token"');
      expect(text).toContain('chain = ["claude", "pi"]');
      expect(text).toContain("[harnesses.personas.kai]");
      expect(text).toContain("# my hand-written config");
      // The global keys are gone from the SETTINGS (the header comment still
      // names them, which is how the owner finds where they went).
      expect(text).not.toContain('default_persona = "lena"');
      expect(text).not.toContain('update_channel = "preview"');
    }
  });

  test("the global keys land in the global file", async () => {
    await writeOldLayout();
    migrateHostLayout();
    const global = await readFile(join(personasDir, "config.toml"), "utf8");
    expect(global).toContain('default_persona = "lena"');
    expect(global).toContain('update_channel = "preview"');
  });

  test("secrets, state, database and runtime markers follow the default persona", async () => {
    await writeOldLayout();
    migrateHostLayout();
    const lena = join(personasDir, "lena");
    expect(await readFile(join(lena, ".env"), "utf8")).toContain("TTS_KEY=secret");
    expect(await readFile(join(lena, "memory.sqlite"), "utf8")).toBe("DB");
    expect(JSON.parse(await readFile(join(lena, "state.json"), "utf8")).harness_bins).toEqual({
      pi: "/opt/pi",
    });
    expect(existsSync(join(lena, "run", "heartbeat.last-fired"))).toBe(true);
  });

  test("the memory index was already per persona, so each keeps its own", async () => {
    await writeOldLayout();
    migrateHostLayout();
    expect(
      await readFile(join(personasDir, "lena", "memory-index.sqlite"), "utf8"),
    ).toBe("LENA");
    expect(
      await readFile(join(personasDir, "kai", "memory-index.sqlite"), "utf8"),
    ).toBe("KAI");
  });

  test("the non-default persona's empty database is REPORTED, not hidden", async () => {
    await writeOldLayout();
    const report = migrateHostLayout();
    expect(report.notes.join(" ")).toContain("kai starts with an empty");
  });

  test("nothing is deleted — the old directories are renamed aside", async () => {
    await writeOldLayout();
    const report = migrateHostLayout();
    expect(existsSync(oldConfigDir)).toBe(false);
    expect(report.archived.length).toBeGreaterThan(0);
    for (const dir of report.archived) {
      expect(dir).toContain(".pre-435-");
      expect(existsSync(dir)).toBe(true);
    }
    // Undo is a rename back, so the original bytes must still be readable.
    const archivedConfig = report.archived.find((d) => d.includes("config"))!;
    expect(await readFile(join(archivedConfig, "config.toml"), "utf8")).toBe(HOST_CONFIG);
  });

  test("running twice changes nothing the second time", async () => {
    await writeOldLayout();
    migrateHostLayout();
    const first = await readFile(join(personasDir, "lena", "config.toml"), "utf8");
    expect(needsMigration()).toBe(false);
    const second = migrateHostLayout();
    expect(second.migrated).toBe(false);
    expect(await readFile(join(personasDir, "lena", "config.toml"), "utf8")).toBe(first);
  });

  test("a persona that already has its own config is never overwritten", async () => {
    await writeOldLayout();
    await writeFile(join(personasDir, "kai", "config.toml"), "# kai's own\n", "utf8");
    const report = migrateHostLayout();
    expect(report.personas).toEqual(["lena"]);
    expect(await readFile(join(personasDir, "kai", "config.toml"), "utf8")).toBe("# kai's own\n");
  });
});

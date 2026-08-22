/**
 * One-shot migration from the pre-#435 HOST-GLOBAL layout to the per-persona
 * one. Runs automatically at startup, is idempotent, and is a cheap no-op once
 * there is nothing left to move.
 *
 * What moves, and why the split is what it is:
 *
 *   ~/.config/phantombot/config.toml  → <persona>/config.toml, for EVERY
 *       persona on the box. Copied verbatim (comments and all) rather than
 *       re-serialized, minus the handful of top-level keys that are genuinely
 *       global. Any `[harnesses.personas.X]` / `[channels.telegram.personas.X]`
 *       override tables are left in place: the loader still honours them, so a
 *       migrated box behaves EXACTLY as it did before, and the owner can prune
 *       the copies at leisure. A verbatim copy is the only form of this
 *       migration that cannot silently change behaviour.
 *
 *   ~/.config/phantombot/.env         → <default persona>/.env
 *   ~/.local/share/phantombot/state.json    → <default persona>/state.json
 *   ~/.local/share/phantombot/memory.sqlite → <default persona>/memory.sqlite
 *   ~/.local/share/phantombot/memory-index/<p>.sqlite → <p>/memory-index.sqlite
 *   ~/.local/share/phantombot/logs, inbox   → <default persona>/
 *   ~/.local/state/phantombot/*             → <default persona>/run/
 *
 * The DEFAULT persona inherits the shared database, state and logs because
 * there was only ever one of each and it is the persona that was actually
 * using them; the per-persona memory INDEX was already split by filename, so
 * each persona keeps its own. Other personas start with an empty task/turn
 * database — surfaced in the migration report rather than hidden, because it
 * is the one user-visible consequence.
 *
 * Nothing is deleted. The old directories are RENAMED to
 * `<name>.pre-435-<timestamp>`, so a bad migration is undone by renaming them
 * back. Everything is best-effort: a failure logs and leaves the old layout in
 * place rather than half-migrating and taking the box down.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "./logger.ts";
import {
  dataHome,
  globalConfigPath,
  personasRoot,
  personaRoot,
  personaRunDir,
  setGlobalConfigValue,
} from "./personaPaths.ts";

/** Top-level keys that stay global and must NOT be copied into a persona. */
const GLOBAL_ONLY_KEYS = [
  "default_persona",
  "update_channel",
  "personas_dir",
  "memory_db",
];

export interface MigrationReport {
  /** True when anything at all was moved. */
  migrated: boolean;
  /** Personas that received a copy of the old host config. */
  personas: string[];
  /** Directories renamed out of the way, in the order they were renamed. */
  archived: string[];
  /** Human-readable notes worth surfacing (e.g. "lena starts with an empty DB"). */
  notes: string[];
}

function legacyConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "phantombot");
  return join(homedir(), ".config", "phantombot");
}

function legacyDataDir(): string {
  return join(dataHome(), "phantombot");
}

function legacyStateDir(): string {
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "phantombot");
  return join(homedir(), ".local", "state", "phantombot");
}

/**
 * Strip the global-only keys from a host config.toml.
 *
 * Line-based on purpose: parsing and re-emitting TOML would drop every comment
 * the owner wrote. The keys we remove are all top-level scalars, so a
 * line-anchored match is exact — and we stop at the first `[section]` header so
 * a key of the same name nested inside a table is never touched.
 */
export function stripGlobalKeys(toml: string): string {
  const out: string[] = [];
  let inSection = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (!inSection) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
      if (m && GLOBAL_ONLY_KEYS.includes(m[1]!)) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Read a top-level scalar string out of a host config.toml, comments intact. */
function readTopLevelString(toml: string, key: string): string | undefined {
  let inSection = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (inSection) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** Rename a path out of the way. Returns the new name, or undefined if absent. */
function archive(path: string, stamp: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const dest = `${path}.pre-435-${stamp}`;
  renameSync(path, dest);
  return dest;
}

/** Move a file or directory if the source exists and the destination does not. */
function moveIfAbsent(from: string, to: string): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
  return true;
}

/** Persona directories present under the personas root. */
function listPersonas(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => {
        if (name.startsWith(".")) return false;
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * True when there is anything left to migrate. Cheap enough to call on every
 * startup: three `existsSync` calls.
 */
export function needsMigration(): boolean {
  return (
    existsSync(join(legacyConfigDir(), "config.toml")) ||
    existsSync(join(legacyConfigDir(), ".env")) ||
    existsSync(join(legacyDataDir(), "state.json")) ||
    existsSync(join(legacyDataDir(), "memory.sqlite")) ||
    existsSync(join(legacyDataDir(), "memory-index")) ||
    existsSync(legacyStateDir())
  );
}

export function migrateHostLayout(): MigrationReport {
  const report: MigrationReport = {
    migrated: false,
    personas: [],
    archived: [],
    notes: [],
  };
  if (!needsMigration()) return report;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = personasRoot();
  const personas = listPersonas(root);
  const oldConfigPath = join(legacyConfigDir(), "config.toml");
  const hostToml = existsSync(oldConfigPath) ? readFileSync(oldConfigPath, "utf8") : "";

  // 1. Global file first, so `activePersona()` resolves correctly for every
  //    path computed below. The old default came from state.json (which wins)
  //    and then the host config.
  let defaultPersona: string | undefined;
  try {
    const oldState = JSON.parse(readFileSync(join(legacyDataDir(), "state.json"), "utf8")) as {
      default_persona?: string;
    };
    defaultPersona = oldState.default_persona;
  } catch {
    /* no old state file, or unreadable — fall through to the config */
  }
  defaultPersona ??= readTopLevelString(hostToml, "default_persona");
  if (defaultPersona) setGlobalConfigValue("default_persona", defaultPersona);

  const updateChannel = readTopLevelString(hostToml, "update_channel");
  if (updateChannel) setGlobalConfigValue("update_channel", updateChannel);

  // 2. The host config, verbatim-minus-global-keys, into every persona that
  //    does not already have one of its own.
  if (hostToml) {
    const body = stripGlobalKeys(hostToml);
    const header =
      "# Migrated from ~/.config/phantombot/config.toml by phantombot #435.\n" +
      "# Config is per persona now: this file configures ONLY this persona, so\n" +
      "# several personas can run side by side in one user account. It is a\n" +
      "# verbatim copy of the old host file, so behaviour is unchanged — any\n" +
      "# settings here that belong to another persona are safe to delete.\n" +
      "# `default_persona` and `update_channel` moved to " +
      globalConfigPath() +
      "\n\n";
    for (const persona of personas) {
      const dest = join(personaRoot(persona), "config.toml");
      if (existsSync(dest)) continue;
      mkdirSync(personaRoot(persona), { recursive: true });
      writeFileSync(dest, header + body, "utf8");
      report.personas.push(persona);
      report.migrated = true;
    }
  }

  const target = defaultPersona && personas.includes(defaultPersona)
    ? defaultPersona
    : personas[0];

  if (target) {
    // 3. Secrets, state, database and logs — all singletons, so they go to the
    //    persona that was actually using them.
    const moves: Array<[string, string]> = [
      [join(legacyConfigDir(), ".env"), join(personaRoot(target), ".env")],
      [join(legacyDataDir(), "state.json"), join(personaRoot(target), "state.json")],
      [join(legacyDataDir(), "memory.sqlite"), join(personaRoot(target), "memory.sqlite")],
      [join(legacyDataDir(), "logs"), join(personaRoot(target), "logs")],
      [join(legacyDataDir(), "inbox"), join(personaRunDir(target), "inbox")],
    ];
    for (const [from, to] of moves) {
      if (moveIfAbsent(from, to)) report.migrated = true;
    }
    // SQLite side files travel with their database or the next open sees a
    // truncated WAL and loses the tail of the journal.
    for (const suffix of ["-wal", "-shm"]) {
      moveIfAbsent(
        join(legacyDataDir(), `memory.sqlite${suffix}`),
        join(personaRoot(target), `memory.sqlite${suffix}`),
      );
    }
    for (const other of personas) {
      if (other === target) continue;
      report.notes.push(
        `${other} starts with an empty task/turn database — the shared one went to ${target}, which was using it`,
      );
    }

    // 4. Runtime state: locks, last-fired markers, turn registry, digests.
    const oldState = legacyStateDir();
    if (existsSync(oldState)) {
      mkdirSync(personaRunDir(target), { recursive: true });
      for (const entry of readdirSync(oldState)) {
        moveIfAbsent(join(oldState, entry), join(personaRunDir(target), entry));
      }
      report.migrated = true;
    }
  } else {
    report.notes.push(
      "no persona directories found — host settings were left in place for a later run",
    );
  }

  // 5. The per-persona memory index was already split by filename.
  const oldIndexDir = join(legacyDataDir(), "memory-index");
  if (existsSync(oldIndexDir)) {
    for (const file of readdirSync(oldIndexDir)) {
      const m = /^(.+)\.sqlite(-wal|-shm)?$/.exec(file);
      if (!m) continue;
      const persona = m[1]!;
      if (!existsSync(personaRoot(persona))) continue;
      moveIfAbsent(
        join(oldIndexDir, file),
        join(personaRoot(persona), `memory-index.sqlite${m[2] ?? ""}`),
      );
    }
    report.migrated = true;
  }

  // 6. Archive whatever is left. Renamed, never deleted — undo is a rename back.
  if (report.migrated) {
    for (const dir of [legacyConfigDir(), legacyStateDir(), oldIndexDir]) {
      try {
        const dest = archive(dir, stamp);
        if (dest) report.archived.push(dest);
      } catch (e) {
        log.warn("host-layout migration: could not archive a legacy directory", {
          dir,
          error: (e as Error).message,
        });
      }
    }
  }

  return report;
}

/**
 * Startup wrapper: migrate, log what happened, and never throw. A migration
 * failure must leave the box on the OLD layout and still boot, not wedge the
 * CLI — which is why every filesystem step above is guarded and nothing is
 * deleted.
 */
export function migrateHostLayoutAtStartup(): MigrationReport | undefined {
  try {
    if (!needsMigration()) return undefined;
    const report = migrateHostLayout();
    if (report.migrated) {
      log.info("migrated to the per-persona layout (#435)", {
        personas: report.personas,
        archived: report.archived,
      });
      for (const note of report.notes) log.warn(`migration: ${note}`);
    }
    return report;
  } catch (e) {
    log.warn("host-layout migration failed; leaving the old layout in place", {
      error: (e as Error).message,
    });
    return undefined;
  }
}

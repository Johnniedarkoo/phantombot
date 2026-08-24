/**
 * Tiny READ-ONLY .env parser for the LEGACY plaintext secrets files.
 *
 * Lives at $XDG_CONFIG_HOME/phantombot/.env. As of #452 phantombot never
 * WRITES a .env file and never reads one at runtime: the only remaining
 * consumer is `vaultMigrate.ts`, which imports each file once into the
 * encrypted per-persona vaults and stamps it as done. The writer half
 * (`saveEnvFile`/`updateEnvFile`) has been deleted deliberately — a write path
 * into a file nothing reads is a silent data-loss bug, and re-adding one is
 * what `tests/lib-envFile.test.ts` guards against.
 *
 * Format: standard shell-style `KEY=value`, one per line, no quoting
 * unless the value contains whitespace or `#` (then we wrap in double
 * quotes). Comments (`#`) and blank lines are preserved on read but not
 * surfaced in the parsed map; round-trip will lose them. Acceptable
 * because this file is phantombot-owned.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { xdgConfigHome } from "../config.ts";

export type EnvVars = Record<string, string>;

export function defaultEnvFilePath(): string {
  return (
    process.env.PHANTOMBOT_ENV_FILE ??
    join(xdgConfigHome(), "phantombot", ".env")
  );
}

export async function loadEnvFile(path: string): Promise<EnvVars> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  return parseEnv(text);
}

export function parseEnv(text: string): EnvVars {
  const out: EnvVars = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      // Double-quoted: undo the escapes that quote() applies. Order matters:
      // unescape \\ → \ first, then \" → ", so a literal `\"` two-char value
      // (written as "\\\"") round-trips correctly without double-processing.
      val = val
        .slice(1, -1)
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"');
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

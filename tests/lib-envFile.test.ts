/**
 * envFile.ts is a READ-ONLY legacy parser (#452), plus the guard that keeps it
 * that way.
 *
 * The writer half (saveEnvFile / updateEnvFile) and its round-trip suite were
 * deleted with the write paths themselves: phantombot never writes a .env file
 * any more, and nothing reads one at runtime. The last two tests here are the
 * regression guards — they fail if a new writer or a new runtime reader is
 * added, which is the exact way this migration would silently un-finish.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as envFile from "../src/lib/envFile.ts";
import { loadEnvFile, parseEnv } from "../src/lib/envFile.ts";

let workdir: string;
let envPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-env-"));
  envPath = join(workdir, ".env");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("parseEnv", () => {
  test("parses KEY=value lines, skips comments and blanks", () => {
    expect(
      parseEnv(`# comment\nFOO=bar\n\n  BAZ=qux  \n# another\nQUOTED="with space"\n`),
    ).toEqual({
      FOO: "bar",
      BAZ: "qux",
      QUOTED: "with space",
    });
  });

  test("handles single-quoted values", () => {
    expect(parseEnv(`A='hello world'\n`)).toEqual({ A: "hello world" });
  });

  test("unescapes a double-quoted value written by an older phantombot", () => {
    // The retired writer escaped `\` and `"`. Files it produced are still on
    // disk and still have to import correctly.
    expect(parseEnv(`A="say \\"hi\\""\nB="back\\\\slash"\n`)).toEqual({
      A: 'say "hi"',
      B: "back\\slash",
    });
  });
});

describe("loadEnvFile", () => {
  test("returns {} when the file is missing", async () => {
    expect(await loadEnvFile(envPath)).toEqual({});
  });

  test("reads a hand-written legacy file", async () => {
    await writeFile(envPath, 'FOO=bar\nQUOTED="a b"\n', "utf8");
    expect(await loadEnvFile(envPath)).toEqual({ FOO: "bar", QUOTED: "a b" });
  });
});

describe("no .env WRITE path exists (#452)", () => {
  test("envFile exports no writer", () => {
    const exported = Object.keys(envFile).sort();
    expect(exported).toEqual(["defaultEnvFilePath", "loadEnvFile", "parseEnv"]);
  });
});

describe("no .env RUNTIME READ path exists (#452)", () => {
  /** Every .ts file under src/, recursively. */
  function srcFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) srcFiles(full, out);
      else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  test("vaultMigrate is the only module that imports envFile", () => {
    const importers = srcFiles(join(import.meta.dir, "..", "src"))
      .filter((f) => !f.endsWith("envFile.ts"))
      .filter((f) => /from "[^"]*envFile\.ts"/.test(readFileSync(f, "utf8")))
      .map((f) => f.split("/").pop());
    // A second importer means something reads the plaintext file at runtime
    // again — the exact state #452 removed. Migrate it to the vault
    // (lib/vaultSecrets.ts) instead of widening this list.
    expect(importers.sort()).toEqual(["vaultMigrate.ts"]);
  });

  test("no generated systemd unit sources a .env file", () => {
    const systemd = readFileSync(
      join(import.meta.dir, "..", "src", "lib", "systemd.ts"),
      "utf8",
    );
    // Comments explain why the directive is absent; only an actual emitted
    // `EnvironmentFile=` line (inside a unit template) would re-source it.
    expect(systemd).not.toMatch(/^EnvironmentFile=/m);
  });
});

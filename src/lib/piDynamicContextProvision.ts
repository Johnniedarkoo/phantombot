/** Self-provisioning for the always-on dynamic Pi context extension. */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  PI_DYNAMIC_CONTEXT_EXTENSION_ASSETS_HASH,
  PI_DYNAMIC_CONTEXT_EXTENSION_FILES,
} from "./piExtensionAssets.generated.ts";

const MARKER_FILE = ".phantombot-managed";
const MANAGED_NOTE =
  "MANAGED BY PHANTOMBOT — DO NOT EDIT. Overwritten on startup; edit " +
  "pi-extension/dynamic-context/ in the phantombot repo instead.";

export interface DynamicContextProvisionResult {
  dir: string;
  action: "created" | "updated" | "unchanged";
  wrote: string[];
  pruned: string[];
}

export interface DynamicContextProvisionStatus {
  present: boolean;
  drifted: boolean;
  dir: string;
}

export interface DynamicContextProvisionOpts {
  home?: string;
}

export function dynamicContextExtensionDir(home = os.homedir()): string {
  return path.join(home, ".pi", "agent", "extensions", "dynamic-context");
}

function withManagedHeader(content: string): string {
  return `// ${MANAGED_NOTE}\n${content}`;
}

function desiredFiles(): Map<string, string> {
  return new Map(
    Object.entries(PI_DYNAMIC_CONTEXT_EXTENSION_FILES).map(([rel, content]) => [
      rel,
      withManagedHeader(content),
    ]),
  );
}

function markerContent(): string {
  return JSON.stringify(
    {
      assetsHash: PI_DYNAMIC_CONTEXT_EXTENSION_ASSETS_HASH,
      stampedAt: new Date().toISOString(),
      note: "Managed by phantombot. Re-stamped on startup.",
    },
    null,
    2,
  );
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const rel = entry.name;
    if (entry.isDirectory()) {
      for (const child of await listFiles(path.join(dir, rel))) {
        result.push(path.posix.join(rel, child));
      }
    } else {
      result.push(rel);
    }
  }
  return result;
}

async function pruneEmptyDirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    await pruneEmptyDirs(child);
    try {
      if ((await readdir(child)).length === 0) {
        await rm(child, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup; the next startup can repair it.
    }
  }
}

export async function ensureDynamicContextExtension(
  opts: DynamicContextProvisionOpts = {},
): Promise<DynamicContextProvisionResult> {
  const dir = dynamicContextExtensionDir(opts.home);
  const existedBefore = existsSync(dir);
  const files = desiredFiles();
  await mkdir(dir, { recursive: true });

  const wrote: string[] = [];
  for (const [rel, content] of files) {
    const full = path.join(dir, rel);
    if ((await readIfExists(full)) !== content) {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      wrote.push(rel);
    }
  }

  const marker = path.join(dir, MARKER_FILE);
  const existingMarker = await readIfExists(marker);
  if (!existingMarker?.includes(`"assetsHash": "${PI_DYNAMIC_CONTEXT_EXTENSION_ASSETS_HASH}"`)) {
    await writeFile(marker, markerContent(), "utf8");
    wrote.push(MARKER_FILE);
  }

  const allowed = new Set([...files.keys(), MARKER_FILE]);
  const pruned: string[] = [];
  for (const rel of await listFiles(dir)) {
    if (!allowed.has(rel)) {
      await rm(path.join(dir, rel), { force: true });
      pruned.push(rel);
    }
  }
  if (pruned.length > 0) await pruneEmptyDirs(dir);

  return {
    dir,
    action: !existedBefore ? "created" : wrote.length || pruned.length ? "updated" : "unchanged",
    wrote,
    pruned,
  };
}

export async function dynamicContextExtensionStatus(
  opts: DynamicContextProvisionOpts = {},
): Promise<DynamicContextProvisionStatus> {
  const dir = dynamicContextExtensionDir(opts.home);
  const files = desiredFiles();
  const present = existsSync(dir) && (await readIfExists(path.join(dir, MARKER_FILE))) !== undefined;
  if (!present) return { present: false, drifted: true, dir };

  const marker = await readIfExists(path.join(dir, MARKER_FILE));
  let drifted = !marker?.includes(`"assetsHash": "${PI_DYNAMIC_CONTEXT_EXTENSION_ASSETS_HASH}"`);
  for (const [rel, content] of files) {
    if ((await readIfExists(path.join(dir, rel))) !== content) {
      drifted = true;
      break;
    }
  }
  if (!drifted) {
    const allowed = new Set([...files.keys(), MARKER_FILE]);
    for (const rel of await listFiles(dir)) {
      if (!allowed.has(rel)) {
        drifted = true;
        break;
      }
    }
  }
  return { present: true, drifted, dir };
}

/**
 * launchd unit (plist) generation and install/uninstall logic for
 * phantombot on macOS.
 *
 * Mirrors the shape of `systemd.ts` so the per-platform router in
 * `platform.ts` can dispatch to either backend with the same surface
 * area. The `LaunchctlRunner` indirection keeps this testable: tests
 * inject a fake runner instead of actually invoking `launchctl`.
 *
 * Path layout (per-user LaunchAgents — equivalent of systemd --user):
 *
 *   ~/Library/LaunchAgents/dev.phantombot.phantombot.plist
 *   ~/Library/LaunchAgents/dev.phantombot.heartbeat.plist
 *   ~/Library/LaunchAgents/dev.phantombot.tick.plist
 *
 * Logs go to ~/Library/Logs/phantombot/<unit>.{out,err}.log (no journald
 * on Mac, and `log show` is a poor fit for free-form bot output). launchd
 * appends to them forever with no size cap, so the heartbeat rotates them
 * itself — see src/lib/logRotate.ts.
 *
 * Note on env files: launchd's `EnvironmentVariables` plist key only
 * accepts inline static values — it has no equivalent of systemd's
 * `EnvironmentFile=`. Phantombot self-loads `~/.env` and
 * `~/.config/phantombot/.env` at startup (see src/index.ts), so the
 * agent finds credentials in process.env on both platforms without
 * needing per-plist env entries here.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isPhantombotBinary } from "./binaryIdentity.ts";
import type { WriteSink } from "./io.ts";
import { activePersona, FALLBACK_PERSONA, personaLogDir } from "./personaPaths.ts";

/**
 * Labels are PERSONA-SCOPED since #435 — `dev.phantombot.<persona>.phantombot`
 * rather than one shared `dev.phantombot.phantombot`. A single label meant
 * installing persona B booted B's agent over A's and left one daemon serving
 * the wrong persona; launchd keys everything (bootstrap, bootout, logs) off the
 * label, so the label IS the isolation boundary on macOS.
 *
 * Sanitized because a label with a `/` in it would escape the LaunchAgents
 * directory when turned into a plist filename.
 */
function labelSlug(persona?: string): string {
  const name = (persona ?? activePersona()).trim() || FALLBACK_PERSONA;
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function phantombotPlistLabel(persona?: string): string {
  return `dev.phantombot.${labelSlug(persona)}.phantombot`;
}
export function heartbeatPlistLabel(persona?: string): string {
  return `dev.phantombot.${labelSlug(persona)}.heartbeat`;
}
export function tickPlistLabel(persona?: string): string {
  return `dev.phantombot.${labelSlug(persona)}.tick`;
}

/** Pre-#435 shared labels. Kept only so an upgrade can bootout and delete them. */
export const LEGACY_PHANTOMBOT_PLIST_LABEL = "dev.phantombot.phantombot";
export const LEGACY_HEARTBEAT_PLIST_LABEL = "dev.phantombot.heartbeat";
export const LEGACY_TICK_PLIST_LABEL = "dev.phantombot.tick";
/**
 * RETIRED label. The nightly no longer runs on a clock (startup + the
 * heartbeat's day-rollover check trigger it now — see nightlyTrigger.ts), so
 * this plist is never generated. The label survives only so an upgrade can
 * bootout and delete what an older install left in the gui domain.
 */
export const NIGHTLY_PLIST_LABEL = "dev.phantombot.nightly";

/**
 * Every label an install must bootout and delete: the retired nightly, plus
 * the three pre-#435 host-global agents.
 *
 * The launchd analogue of systemd's RETIRED_UNIT_NAMES, and it exists for the
 * same reason (#436): leaving `dev.phantombot.phantombot` loaded after an
 * upgrade means two daemons — the old shared one and the new persona-scoped
 * one — racing for the same run lock and the same database, which is the exact
 * bug the persona boundary exists to end.
 */
export const RETIRED_PLIST_LABELS = [
  NIGHTLY_PLIST_LABEL,
  LEGACY_TICK_PLIST_LABEL,
  LEGACY_HEARTBEAT_PLIST_LABEL,
  LEGACY_PHANTOMBOT_PLIST_LABEL,
] as const;

/** Plist paths of {@link RETIRED_PLIST_LABELS} in the user's LaunchAgents dir. */
export function retiredPlistPaths(dir: string = launchAgentsDir()): string[] {
  return RETIRED_PLIST_LABELS.map((label) => join(dir, `${label}.plist`));
}

/**
 * The pre-#435 label a given persona-scoped label replaces, or undefined when
 * nothing scoped replaces it. Retirement is decided per ROLE off this map: a
 * legacy agent may only be swept once the scoped agent taking over its job is
 * confirmed live, so a partial reconcile can never leave BOTH loaded.
 *
 * {@link NIGHTLY_PLIST_LABEL} is deliberately absent — the nightly no longer
 * runs on a clock, so no scoped agent replaces it and it is retired only on a
 * fully converged reconcile.
 */
export function legacyLabelReplacedBy(
  scopedLabel: string,
  persona?: string,
): string | undefined {
  if (scopedLabel === phantombotPlistLabel(persona))
    return LEGACY_PHANTOMBOT_PLIST_LABEL;
  if (scopedLabel === heartbeatPlistLabel(persona))
    return LEGACY_HEARTBEAT_PLIST_LABEL;
  if (scopedLabel === tickPlistLabel(persona)) return LEGACY_TICK_PLIST_LABEL;
  return undefined;
}

/**
 * Bootout and delete every retired agent. Best-effort per label: a bootout of
 * something that was never loaded returns non-zero and that is fine — the goal
 * is only that nothing pre-#435 is left active or on disk afterwards.
 *
 * `nightlyPlistPath` is an override so existing tests can keep pointing the
 * nightly at a tmpdir; the rest resolve under the same directory as that one
 * when it is given, so a test never touches the real ~/Library/LaunchAgents.
 */
export async function removeRetiredPlists(opts: {
  domain: string;
  launchctl: LaunchctlRunner;
  out: WriteSink;
  dir?: string;
  /**
   * Retire only these labels. Defaults to all of {@link RETIRED_PLIST_LABELS}.
   * The reconcile path passes a subset so a legacy agent is retired exactly
   * when the scoped agent that replaces it is confirmed live — see
   * {@link ensureLaunchdAgentsCurrent}.
   */
  labels?: readonly string[];
}): Promise<string[]> {
  const removed: string[] = [];
  for (const label of opts.labels ?? RETIRED_PLIST_LABELS) {
    const path = join(opts.dir ?? launchAgentsDir(), `${label}.plist`);
    const onDisk = existsSync(path);
    // Bootout even when the plist is gone: launchd keeps a loaded job in the
    // domain until it is booted out, so a hand-deleted plist can still leave a
    // live agent behind.
    await opts.launchctl.run(["bootout", `${opts.domain}/${label}`]);
    if (onDisk) {
      await unlink(path);
      opts.out.write(`removed retired plist: ${path}\n`);
      removed.push(path);
    }
  }
  return removed;
}


function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

/**
 * Directory launchd writes every unit's stdout/stderr into. Exported so the
 * log-rotation pass (#428) can cap the files launchd itself never rotates.
 */
export function launchdLogsDir(persona?: string): string {
  // Per persona (#436), matching Windows (taskLogsDir -> personaLogDir) and the
  // rest of the boundary: logs are persona state, and the pre-#436 host-global
  // ~/Library/Logs/phantombot left two personas' output interleaved in one dir
  // that no persona owned — and outside the tree an operator backs up or wipes
  // when they retire a persona.
  return personaLogDir(persona);
}

function logsDir(persona?: string): string {
  return launchdLogsDir(persona);
}

export function defaultPlistPath(persona?: string): string {
  return join(launchAgentsDir(), `${phantombotPlistLabel(persona)}.plist`);
}

/**
 * Absolute paths of the main agent's stdout/stderr logs on macOS
 * (~/Library/Logs/phantombot/<label>.{out,err}.log). Mirrors the paths
 * baked into the plist's StandardOutPath/StandardErrorPath, so `phantombot
 * logs` tails the same files launchd writes.
 */
export function launchdLogPaths(persona?: string): { out: string; err: string } {
  const base = join(logsDir(persona), phantombotPlistLabel(persona));
  return { out: `${base}.out.log`, err: `${base}.err.log` };
}

export function heartbeatPlistPath(persona?: string): string {
  return join(launchAgentsDir(), `${heartbeatPlistLabel(persona)}.plist`);
}

/** Path of the retired nightly plist (kept for cleanup only). */
export function nightlyPlistPath(): string {
  return join(launchAgentsDir(), `${NIGHTLY_PLIST_LABEL}.plist`);
}

export function tickPlistPath(persona?: string): string {
  return join(launchAgentsDir(), `${tickPlistLabel(persona)}.plist`);
}

/**
 * XML-escape a value for inclusion in a plist string. Plists are XML, so
 * `&`, `<`, `>` need entities — the rest survive intact.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PLIST_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';
const PLIST_FOOTER = "</plist>\n";

interface BasePlistOptions {
  label: string;
  binPath: string;
  args: readonly string[];
  /** When true, KeepAlive=true + RunAtLoad=true (long-running daemon). */
  keepAlive?: boolean;
  /** Seconds between firings (StartInterval). Mutually exclusive with calendar. */
  startIntervalSec?: number;
  /** Calendar firing (e.g. {Hour: 2, Minute: 0}). */
  startCalendar?: { Hour?: number; Minute?: number; Weekday?: number };
  /** When true, sets RunAtLoad=true so the unit fires once on load (and again per StartInterval). */
  runAtLoad?: boolean;
  /**
   * Persona this agent serves, exported as PHANTOMBOT_PERSONA so the process
   * resolves its config, state, database and tmp dir from `<persona>/` with no
   * ambient default to get wrong.
   */
  persona: string;
}

function generatePlist(opts: BasePlistOptions): string {
  const argv = [opts.binPath, ...opts.args];
  const argvXml = argv
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");

  const lines: string[] = [];
  lines.push(PLIST_HEADER + "<dict>");
  lines.push(`  <key>Label</key>`);
  lines.push(`  <string>${xmlEscape(opts.label)}</string>`);
  lines.push(`  <key>ProgramArguments</key>`);
  lines.push(`  <array>`);
  lines.push(argvXml);
  lines.push(`  </array>`);

  if (opts.runAtLoad ?? opts.keepAlive) {
    lines.push(`  <key>RunAtLoad</key>`);
    lines.push(`  <true/>`);
  }
  if (opts.keepAlive) {
    // Restart on crash. The dict form lets us be more precise (don't restart
    // on clean exit), but the boolean form is simpler and matches the
    // systemd Restart=on-failure semantics closely enough.
    lines.push(`  <key>KeepAlive</key>`);
    lines.push(`  <true/>`);
    lines.push(`  <key>ThrottleInterval</key>`);
    lines.push(`  <integer>5</integer>`);
  }
  if (opts.startIntervalSec !== undefined) {
    lines.push(`  <key>StartInterval</key>`);
    lines.push(`  <integer>${opts.startIntervalSec}</integer>`);
  }
  if (opts.startCalendar) {
    lines.push(`  <key>StartCalendarInterval</key>`);
    lines.push(`  <dict>`);
    for (const [k, v] of Object.entries(opts.startCalendar)) {
      lines.push(`    <key>${xmlEscape(k)}</key>`);
      lines.push(`    <integer>${v}</integer>`);
    }
    lines.push(`  </dict>`);
  }

  // PATH: include ~/.pi/agent/bin and ~/.local/bin so the harness's Bash
  // tool finds `phantombot` and `pi` when the agent invokes them. Mac
  // default PATH is narrow (/usr/bin:/bin:/usr/sbin:/sbin), so we have to
  // be explicit. $HOME interpolation isn't supported in plist values, so
  // we resolve it eagerly at install time using homedir().
  const home = homedir();
  const pathValue = `${home}/.pi/agent/bin:${home}/.local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  lines.push(`  <key>EnvironmentVariables</key>`);
  lines.push(`  <dict>`);
  lines.push(`    <key>PATH</key>`);
  lines.push(`    <string>${xmlEscape(pathValue)}</string>`);
  lines.push(`    <key>PHANTOMBOT_PERSONA</key>`);
  lines.push(`    <string>${xmlEscape(opts.persona)}</string>`);
  lines.push(`  </dict>`);

  // Logs: ~/Library/Logs/phantombot/<label>.{out,err}.log. Created on demand
  // by launchd; we just point at them.
  const logBase = join(logsDir(opts.persona), opts.label);
  lines.push(`  <key>StandardOutPath</key>`);
  lines.push(`  <string>${xmlEscape(logBase + ".out.log")}</string>`);
  lines.push(`  <key>StandardErrorPath</key>`);
  lines.push(`  <string>${xmlEscape(logBase + ".err.log")}</string>`);

  // Working dir: the user's home, mirroring how systemd starts a user unit
  // with HOME-cwd. Some phantombot subcommands resolve relative paths
  // against cwd, so this matters.
  lines.push(`  <key>WorkingDirectory</key>`);
  lines.push(`  <string>${xmlEscape(home)}</string>`);

  lines.push(`</dict>`);
  lines.push(PLIST_FOOTER);
  return lines.join("\n") + "\n";
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_/.\-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
// Re-export so tests can verify the encoded ExecStart equivalent if needed.
export { quoteArg as _quoteArg };

export interface LaunchdUnitParams {
  binPath: string;
  args: readonly string[];
  /** Persona this agent serves. Defaults to the active persona. */
  persona?: string;
}

/** Generate the always-on phantombot agent plist for one persona. */
export function generatePhantombotPlist(params: LaunchdUnitParams): string {
  const persona = params.persona ?? activePersona();
  return generatePlist({
    label: phantombotPlistLabel(persona),
    persona,
    binPath: params.binPath,
    args: params.args,
    keepAlive: true,
    runAtLoad: true,
  });
}

/** Generate the heartbeat plist — fires every 30 minutes. */
export function generateHeartbeatPlist(binPath: string, personaName?: string): string {
  const persona = personaName ?? activePersona();
  return generatePlist({
    label: heartbeatPlistLabel(persona),
    persona,
    binPath,
    args: ["heartbeat"],
    startIntervalSec: 30 * 60,
  });
}

/**
 * Generate the tick plist — fires every 60 seconds.
 *
 * launchd's minimum reliable StartInterval is roughly 10s; 60s matches
 * the systemd timer cadence exactly so cron-style schedules behave the
 * same on both platforms.
 */
export function generateTickPlist(binPath: string, personaName?: string): string {
  const persona = personaName ?? activePersona();
  return generatePlist({
    label: tickPlistLabel(persona),
    persona,
    binPath,
    args: ["tick"],
    startIntervalSec: 60,
  });
}

export interface LaunchctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LaunchctlRunner {
  run(args: readonly string[]): Promise<LaunchctlResult>;
}

export class BunLaunchctlRunner implements LaunchctlRunner {
  async run(args: readonly string[]): Promise<LaunchctlResult> {
    const proc = Bun.spawn(["launchctl", ...args], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }
}

/**
 * Resolve the gui domain target for the current user. launchd's modern
 * (10.10+) command surface is domain-scoped: `gui/<uid>` is the user's
 * graphical session, the closest analogue to systemd --user.
 *
 * Tests inject the uid; production reads process.getuid() directly.
 */
export function guiDomain(uid?: number): string {
  const u = uid ?? process.getuid?.();
  if (u === undefined) {
    throw new Error("cannot determine current uid for launchd gui domain");
  }
  return `gui/${u}`;
}

export interface InstallLaunchdOptions {
  binPath: string;
  /** Path overrides — tests use these to keep writes inside a tmpdir. */
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  /** Override gui domain (e.g. gui/501). Defaults to gui/<current uid>. */
  domain?: string;
  launchctl: LaunchctlRunner;
  out: WriteSink;
  err: WriteSink;
}

/** One launchd agent phantombot installs: where it lives, its label, its body. */
export interface PhantombotPlistTarget {
  path: string;
  label: string;
  body: string;
}

/** Optional per-plist path overrides (tests keep writes inside a tmpdir). */
export interface PhantombotPlistPathOverrides {
  plistPath?: string;
  heartbeatPlistPath?: string;
  tickPlistPath?: string;
  /** Retired nightly path — never generated, only used to anchor cleanup. */
  nightlyPlistPath?: string;
}

/**
 * Canonical (path, label, body) tuples for every agent phantombot installs.
 *
 * Single source of truth shared by `installPhantombotPlists` (writes them
 * fresh) and `ensureLaunchdAgentsCurrent` (rewrites whatever drifted), the
 * launchd analogue of `phantombotUnitTargets` in systemd.ts — and for the same
 * reason: two copies of the same list drift.
 */
export function phantombotPlistTargets(
  binPath: string,
  persona?: string,
  overrides: PhantombotPlistPathOverrides = {},
): PhantombotPlistTarget[] {
  return [
    {
      path: overrides.plistPath ?? defaultPlistPath(persona),
      label: phantombotPlistLabel(persona),
      body: generatePhantombotPlist({ binPath, args: ["run"], persona }),
    },
    {
      path: overrides.heartbeatPlistPath ?? heartbeatPlistPath(persona),
      label: heartbeatPlistLabel(persona),
      body: generateHeartbeatPlist(binPath, persona),
    },
    {
      path: overrides.tickPlistPath ?? tickPlistPath(persona),
      label: tickPlistLabel(persona),
      body: generateTickPlist(binPath, persona),
    },
  ];
}

/**
 * Write the three plists, then bootstrap each into the user's gui domain.
 *
 * `bootstrap` is the modern install verb (replaces `load`). It both loads
 * the unit and starts it (for KeepAlive=true) or schedules it (for
 * StartInterval/StartCalendarInterval). If a unit with the same Label is
 * already loaded, bootstrap fails with EBUSY — we bootout first to make
 * the operation idempotent for upgrade scenarios.
 */
export async function installPhantombotPlists(
  opts: InstallLaunchdOptions,
): Promise<{ installed: boolean }> {
  const domain = opts.domain ?? guiDomain();
  const mainPath = opts.plistPath ?? defaultPlistPath();
  const hbPath = opts.heartbeatPlistPath ?? heartbeatPlistPath();
  const ngPath = opts.nightlyPlistPath ?? nightlyPlistPath();
  const tkPath = opts.tickPlistPath ?? tickPlistPath();

  const plists = phantombotPlistTargets(opts.binPath, undefined, {
    plistPath: mainPath,
    heartbeatPlistPath: hbPath,
    tickPlistPath: tkPath,
  });

  // Make sure the logs dir exists — launchd will refuse to start the
  // service if StandardOutPath/StandardErrorPath point at a non-existent
  // directory, and silently truncating the error to journald isn't an
  // option here.
  await mkdir(logsDir(), { recursive: true });

  for (const p of plists) {
    await mkdir(dirname(p.path), { recursive: true });
    await writeFile(p.path, p.body, "utf8");
    opts.out.write(`wrote plist: ${p.path}\n`);
  }

  // Idempotent install: bootout any pre-existing target (best-effort,
  // don't fail if it isn't loaded), then bootstrap fresh.
  for (const p of plists) {
    await opts.launchctl.run(["bootout", `${domain}/${p.label}`]);
  }
  for (const p of plists) {
    const r = await opts.launchctl.run(["bootstrap", domain, p.path]);
    if (r.exitCode !== 0) {
      opts.err.write(
        `launchctl bootstrap ${domain} ${p.path} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
  }

  // Upgrade cleanup: bootout + delete the retired nightly agent AND every
  // pre-#435 host-global agent, so an upgraded Mac cannot end up with the old
  // shared daemon still loaded alongside the persona-scoped one.
  await removeRetiredPlists({
    domain,
    launchctl: opts.launchctl,
    out: opts.out,
    dir: dirname(ngPath),
  });
  opts.out.write(
    `bootstrapped ${phantombotPlistLabel()} + heartbeat + tick into ${domain}\n`,
  );
  return { installed: true };
}

export interface UninstallLaunchdOptions {
  /** Path overrides — tests use these to keep writes inside a tmpdir. */
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  domain?: string;
  launchctl: LaunchctlRunner;
  out: WriteSink;
  err: WriteSink;
}

export async function uninstallPhantombotPlists(
  opts: UninstallLaunchdOptions,
): Promise<{ removed: boolean }> {
  const domain = opts.domain ?? guiDomain();
  const mainPath = opts.plistPath ?? defaultPlistPath();
  const hbPath = opts.heartbeatPlistPath ?? heartbeatPlistPath();
  const ngPath = opts.nightlyPlistPath ?? nightlyPlistPath();
  const tkPath = opts.tickPlistPath ?? tickPlistPath();

  const labels = [
    tickPlistLabel(),
    heartbeatPlistLabel(),
    phantombotPlistLabel(),
    // Retired/pre-#435 identities too: uninstall means nothing phantombot ever
    // installed is left loaded, not just what THIS version installs.
    ...RETIRED_PLIST_LABELS,
  ];
  // bootout each label (best-effort). A missing target returns non-zero
  // — that's fine, we just want it gone from the domain.
  for (const label of labels) {
    const r = await opts.launchctl.run(["bootout", `${domain}/${label}`]);
    if (r.exitCode !== 0) {
      opts.out.write(
        `launchctl bootout ${domain}/${label} returned ${r.exitCode} (continuing)\n`,
      );
    }
  }

  // Main plist gets a "(no plist at …)" log if absent so the user can tell
  // whether they ever installed; companion plists are silent if absent.
  if (existsSync(mainPath)) {
    await unlink(mainPath);
    opts.out.write(`removed ${mainPath}\n`);
  } else {
    opts.out.write(`(no plist at ${mainPath})\n`);
  }
  for (const p of new Set([hbPath, ngPath, tkPath, ...retiredPlistPaths(dirname(ngPath))])) {
    if (existsSync(p)) {
      await unlink(p);
      opts.out.write(`removed ${p}\n`);
    }
  }

  return { removed: true };
}

export interface LaunchdServiceControl {
  isActive(): Promise<boolean>;
  start(): Promise<{ ok: boolean; stderr?: string }>;
  stop(): Promise<{ ok: boolean; stderr?: string }>;
  restart(): Promise<{ ok: boolean; stderr?: string }>;
  rerenderUnitIfStale(): Promise<{ rerendered: boolean; backupPath?: string }>;
}

/**
 * Compare the on-disk plist at plistPath against the canonical template
 * for binPath. If absent or different, write the canonical template and
 * `launchctl bootout` + `launchctl bootstrap` to reload. Returns whether
 * a rerender happened and, if it did, the path of any backup written.
 */
export async function ensurePlistCurrent(opts: {
  plistPath: string;
  binPath: string;
  domain: string;
  launchctl: LaunchctlRunner;
}): Promise<{ rerendered: boolean; backupPath?: string }> {
  const expected = generatePhantombotPlist({
    binPath: opts.binPath,
    args: ["run"],
  });
  let current: string | undefined;
  if (existsSync(opts.plistPath)) {
    current = await readFile(opts.plistPath, "utf8");
  }
  if (current === expected) return { rerendered: false };
  await mkdir(dirname(opts.plistPath), { recursive: true });
  let backupPath: string | undefined;
  if (current !== undefined) {
    backupPath = `${opts.plistPath}.bak`;
    await writeFile(backupPath, current, "utf8");
  }
  await writeFile(opts.plistPath, expected, "utf8");
  // Reload so launchd picks up the new plist body.
  await opts.launchctl.run([
    "bootout",
    `${opts.domain}/${phantombotPlistLabel()}`,
  ]);
  await opts.launchctl.run(["bootstrap", opts.domain, opts.plistPath]);
  return { rerendered: true, backupPath };
}

export interface EnsureLaunchdAgentsOptions extends PhantombotPlistPathOverrides {
  binPath: string;
  /** Persona these agents serve. Defaults to the active persona. */
  persona?: string;
  domain: string;
  launchctl: LaunchctlRunner;
}

export interface EnsureLaunchdAgentsResult {
  /** Plist filenames whose body was (re)written. */
  rewrote: string[];
  /** Backups taken of drifted plists before overwriting. */
  backups: string[];
  /** Labels booted out + bootstrapped (rewritten, missing, or not loaded). */
  reloaded: string[];
  /** Retired plist paths deleted. */
  removedRetired: string[];
  /**
   * Scoped agents whose bootstrap failed, with the launchctl error. Non-empty
   * means the reconcile did NOT converge: the legacy agent each failed role
   * replaces is left loaded rather than the box ending up with none for that
   * role, and the retired nightly is left alone entirely.
   */
  failures: { label: string; error: string }[];
  /**
   * Labels whose drifted plist we rewrote, failed to reload, and then restored
   * from the `.bak` and re-bootstrapped. These are back on the OLD body — stale
   * but running, which beats down.
   */
  rolledBack: string[];
}

/**
 * Idempotently reconcile the macOS agents: make every persona-scoped plist
 * match the running binary's templates, make sure each is actually loaded in
 * the gui domain, and bootout + delete every retired (pre-#435) agent.
 *
 * This is the launchd analogue of `ensureSystemdUnitsCurrent`, and #436 is why
 * it exists. Renaming the labels per persona means an upgraded Mac would keep
 * only the OLD host-global agents loaded while `start`/`restart`/`status`/
 * `logs` all target the NEW label — restart and diagnostics break until the
 * operator manually reruns `phantombot install`. Wiring this into the
 * unattended heal path (the heartbeat) means an upgrade needs no action, which
 * is what README promises.
 *
 * Best-effort per agent for BOOTOUT: booting out something that was never
 * loaded exits non-zero and that is fine. BOOTSTRAP is not best-effort — a
 * failure is recorded in `failures`, the drifted plist is rolled back to its
 * previous body where we have one, and the legacy agent for THAT role is left
 * loaded — so the box never ends up with neither the old agent nor the new one
 * for any role, and never with both.
 */
export async function ensureLaunchdAgentsCurrent(
  opts: EnsureLaunchdAgentsOptions,
): Promise<EnsureLaunchdAgentsResult> {
  const targets = phantombotPlistTargets(opts.binPath, opts.persona, opts);

  const rewrote: string[] = [];
  const backups: string[] = [];
  const reloaded: string[] = [];
  const failures: { label: string; error: string }[] = [];
  const rolledBack: string[] = [];
  // Scoped labels confirmed to be loaded in the domain when we are done —
  // whether we reloaded them now, found them already healthy and skipped them,
  // or rolled them back onto their previous body. Each one earns the
  // retirement of the legacy agent it replaces, and NOTHING else does.
  const live = new Set<string>();

  // launchd refuses to start an agent whose StandardOutPath directory does not
  // exist, so create it before anything is bootstrapped.
  await mkdir(logsDir(opts.persona), { recursive: true });

  for (const t of targets) {
    let current: string | undefined;
    if (existsSync(t.path)) current = await readFile(t.path, "utf8");
    const drifted = current !== t.body;
    let backupPath: string | undefined;
    if (drifted) {
      await mkdir(dirname(t.path), { recursive: true });
      if (current !== undefined) {
        backupPath = `${t.path}.bak`;
        await writeFile(backupPath, current, "utf8");
        backups.push(backupPath);
      }
      await writeFile(t.path, t.body, "utf8");
      rewrote.push(basename(t.path));
    }
    // Reload when the body changed, and also when the agent simply is not in
    // the domain — the post-rename upgrade case, where the plist we just wrote
    // (or an install wrote) is correct on disk but nothing has ever loaded it.
    const loaded = await opts.launchctl.run([
      "print",
      `${opts.domain}/${t.label}`,
    ]);
    const wasLoaded = loaded.exitCode === 0;
    if (!drifted && wasLoaded) {
      // Already correct and already running. It still counts as live: a second
      // reconcile pass must be able to finish a sweep the first one earned but
      // could not complete, otherwise a single partial failure would strand the
      // legacy agents forever.
      live.add(t.label);
      continue;
    }
    await opts.launchctl.run(["bootout", `${opts.domain}/${t.label}`]);
    const r = await opts.launchctl.run(["bootstrap", opts.domain, t.path]);
    if (r.exitCode === 0) {
      reloaded.push(t.label);
      live.add(t.label);
      continue;
    }
    // The reload failed. We have just booted the agent OUT, so doing nothing
    // here leaves a previously-healthy agent permanently down. If the only
    // thing we changed was the body, put the old one back and reload that:
    // stale-but-running beats a correct plist nothing is running.
    const error = r.stderr.trim() || `exit ${r.exitCode}`;
    if (drifted && backupPath !== undefined && current !== undefined) {
      await writeFile(t.path, current, "utf8");
      const back = await opts.launchctl.run(["bootstrap", opts.domain, t.path]);
      const idx = rewrote.indexOf(basename(t.path));
      if (idx >= 0) rewrote.splice(idx, 1);
      if (back.exitCode === 0) {
        rolledBack.push(t.label);
        // Stale body, but the scoped agent IS running this role. Leaving its
        // legacy twin loaded alongside it is the two-daemons race, so it is
        // live for retirement purposes even though it is still a failure.
        live.add(t.label);
        failures.push({
          label: t.label,
          error: `${error} (rolled back to the previous plist)`,
        });
        continue;
      }
    }
    failures.push({ label: t.label, error });
  }

  // Retire the old identities ROLE BY ROLE, each one exactly when the scoped
  // agent that replaces it is confirmed live.
  //
  // Neither extreme is safe. Sweeping unconditionally would boot out and DELETE
  // the only agents left running when bootstrap fails, leaving an upgraded Mac
  // with no daemon, no heartbeat and no tick — and no plist to recover from.
  // But gating the whole sweep on total success is just as wrong in the other
  // direction: if two of three scoped agents come up and one does not, ALL the
  // legacy agents stay loaded, so the box runs two daemons and two heartbeats
  // against one database — the exact race the persona boundary exists to end.
  // Per-role retirement leaves exactly one agent per role in every case.
  //
  // The nightly has no scoped replacement, so it keeps the conservative gate:
  // it is only removed on a fully converged reconcile.
  const retireable = new Set<string>();
  for (const t of targets) {
    if (!live.has(t.label)) continue;
    const legacy = legacyLabelReplacedBy(t.label, opts.persona);
    if (legacy !== undefined) retireable.add(legacy);
  }
  if (failures.length === 0) retireable.add(NIGHTLY_PLIST_LABEL);
  const removedRetired =
    retireable.size > 0
      ? await removeRetiredPlists({
          domain: opts.domain,
          launchctl: opts.launchctl,
          out: { write: () => {} },
          dir: dirname(opts.nightlyPlistPath ?? nightlyPlistPath()),
          labels: RETIRED_PLIST_LABELS.filter((l) => retireable.has(l)),
        })
      : [];

  return { rewrote, backups, reloaded, removedRetired, failures, rolledBack };
}

/**
 * Default LaunchdServiceControl backed by real launchctl. Returns
 * isActive=false on any error so callers can treat "service unknown" the
 * same as "not running".
 */
export function defaultLaunchdServiceControl(): LaunchdServiceControl {
  const runner = new BunLaunchctlRunner();
  return {
    async isActive() {
      // `launchctl print gui/<uid>/<label>` returns 0 if loaded.
      // `launchctl list <label>` is the legacy form — also returns 0 if
      // loaded but is deprecated. Use print which is reliable on 10.10+.
      let domain: string;
      try {
        domain = guiDomain();
      } catch {
        return false;
      }
      const r = await runner.run([
        "print",
        `${domain}/${phantombotPlistLabel()}`,
      ]);
      return r.exitCode === 0;
    },
    async start() {
      let domain: string;
      try {
        domain = guiDomain();
      } catch (e) {
        return { ok: false, stderr: (e as Error).message };
      }
      const target = `${domain}/${phantombotPlistLabel()}`;
      // Our main agent is KeepAlive=true, so `stop()` fully unloads it with
      // `bootout` (a mere SIGTERM would be relaunched). `start` is therefore
      // the inverse: if the agent is already loaded, `kickstart` (re)starts it;
      // if it was booted out, `bootstrap` reloads it from the plist. Splitting
      // on load state sidesteps bootstrap's EBUSY-when-already-loaded error.
      const loaded = await runner.run(["print", target]);
      if (loaded.exitCode === 0) {
        const r = await runner.run(["kickstart", target]);
        return r.exitCode === 0
          ? { ok: true }
          : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
      }
      const plistPath = defaultPlistPath();
      if (!existsSync(plistPath)) {
        return {
          ok: false,
          stderr: `no LaunchAgent installed at ${plistPath} — run 'phantombot install' first`,
        };
      }
      const r = await runner.run(["bootstrap", domain, plistPath]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async stop() {
      let domain: string;
      try {
        domain = guiDomain();
      } catch (e) {
        return { ok: false, stderr: (e as Error).message };
      }
      const target = `${domain}/${phantombotPlistLabel()}`;
      // KeepAlive=true means a plain `kill` would be relaunched immediately.
      // `bootout` unloads the agent from the domain so it stays stopped until
      // the next `start()`.
      const r = await runner.run(["bootout", target]);
      if (r.exitCode === 0) return { ok: true };
      // bootout on a not-loaded agent exits non-zero; treat "already gone" as
      // success rather than surfacing a spurious error.
      const stillLoaded = await runner.run(["print", target]);
      if (stillLoaded.exitCode !== 0) return { ok: true };
      return { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async restart() {
      let domain: string;
      try {
        domain = guiDomain();
      } catch (e) {
        return { ok: false, stderr: (e as Error).message };
      }
      // `kickstart -k` stops the running instance (if any) and starts a
      // fresh one — the launchd analogue of `systemctl restart`.
      const r = await runner.run([
        "kickstart",
        "-k",
        `${domain}/${phantombotPlistLabel()}`,
      ]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async rerenderUnitIfStale() {
      const binPath = process.execPath;
      if (!isPhantombotBinary(binPath)) return { rerendered: false };
      const plistPath = defaultPlistPath();
      if (!existsSync(plistPath)) return { rerendered: false };
      let domain: string;
      try {
        domain = guiDomain();
      } catch {
        return { rerendered: false };
      }
      return ensurePlistCurrent({
        plistPath,
        binPath,
        domain,
        launchctl: runner,
      });
    },
  };
}

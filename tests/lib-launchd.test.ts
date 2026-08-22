/**
 * Tests for launchd plist generation + install/uninstall logic. Uses a
 * fake LaunchctlRunner that records every invocation, so we don't need
 * actual launchctl on the test host (and so these tests pass on Linux CI).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureLaunchdAgentsCurrent,
  generateHeartbeatPlist,
  generatePhantombotPlist,
  generateTickPlist,
  installPhantombotPlists,
  type LaunchctlResult,
  type LaunchctlRunner,
  uninstallPhantombotPlists,
  phantombotPlistLabel,
  heartbeatPlistLabel,
  NIGHTLY_PLIST_LABEL,
  RETIRED_PLIST_LABELS,
  tickPlistLabel,
  launchdLogPaths,
} from "../src/lib/launchd.ts";
import { personaLogDir } from "../src/lib/personaPaths.ts";

class FakeLaunchctl implements LaunchctlRunner {
  calls: string[][] = [];
  responses: LaunchctlResult[] = [];
  async run(args: readonly string[]): Promise<LaunchctlResult> {
    this.calls.push([...args]);
    return (
      this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" }
    );
  }
}

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let mainPath: string;
let hbPath: string;
let ngPath: string;
let tkPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-launchd-"));
  mainPath = join(workdir, `${phantombotPlistLabel()}.plist`);
  hbPath = join(workdir, `${heartbeatPlistLabel()}.plist`);
  ngPath = join(workdir, `${NIGHTLY_PLIST_LABEL}.plist`);
  tkPath = join(workdir, `${tickPlistLabel()}.plist`);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("generatePhantombotPlist", () => {
  test("renders a launch-on-boot, keep-alive plist with the bin path as ProgramArguments", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
    });
    expect(plist).toContain(`<string>${phantombotPlistLabel()}</string>`);
    expect(plist).toContain(
      "<string>/Users/andrew/.local/bin/phantombot</string>",
    );
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    // Always-on units don't get a fire schedule.
    expect(plist).not.toContain("<key>StartInterval</key>");
    expect(plist).not.toContain("<key>StartCalendarInterval</key>");
  });

  test("XML-escapes ampersands and angle brackets in bin path", () => {
    const plist = generatePhantombotPlist({
      binPath: "/usr/local/odd&path/<phantombot>",
      args: ["run"],
    });
    expect(plist).toContain(
      "<string>/usr/local/odd&amp;path/&lt;phantombot&gt;</string>",
    );
  });

  test("includes a usable PATH so subprocess agents can find pi/phantombot", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
    });
    expect(plist).toContain("<key>PATH</key>");
    // /opt/homebrew/bin matters on Apple Silicon — that's where bun lives if
    // installed via brew.
    expect(plist).toContain("/.local/bin");
    expect(plist).toContain("/opt/homebrew/bin");
  });

  /**
   * #436: logs were the last host-global thing left on macOS
   * (~/Library/Logs/phantombot), so two personas in one account interleaved
   * their output in a directory neither owned — and outside the tree an
   * operator backs up or wipes when retiring a persona. Windows already used
   * personaLogDir; macOS now matches.
   */
  test("logs live inside the PERSONA's dir, not host-global ~/Library/Logs", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
      persona: "lena",
    });
    expect(plist).toContain(join(personaLogDir("lena"), phantombotPlistLabel("lena")));
    expect(plist).not.toContain(join("Library", "Logs", "phantombot"));
    expect(launchdLogPaths("lena").out).toBe(
      join(personaLogDir("lena"), `${phantombotPlistLabel("lena")}.out.log`),
    );
    // Two personas never share a log file.
    expect(launchdLogPaths("lena").out).not.toBe(launchdLogPaths("kai").out);
  });

  test("logs go to <persona>/logs/<label>.{out,err}.log", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
    });
    expect(plist).toContain(
      `${phantombotPlistLabel()}.out.log`,
    );
    expect(plist).toContain(
      `${phantombotPlistLabel()}.err.log`,
    );
  });
});

describe("companion plists carry the right schedule", () => {
  test("heartbeat fires every 30 minutes", () => {
    const plist = generateHeartbeatPlist("/usr/local/bin/phantombot");
    expect(plist).toContain(`<string>${heartbeatPlistLabel()}</string>`);
    expect(plist).toContain("<string>heartbeat</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>1800</integer>");
    // No KeepAlive on a periodic oneshot.
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  test("tick fires every 60 seconds", () => {
    const plist = generateTickPlist("/usr/local/bin/phantombot");
    expect(plist).toContain(`<string>${tickPlistLabel()}</string>`);
    expect(plist).toContain("<string>tick</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
  });
});

describe("installPhantombotPlists", () => {
  test("writes the three live plists then bootstraps each into the gui domain", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await installPhantombotPlists({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(true);

    // The retired nightly plist is never written.
    expect(existsSync(ngPath)).toBe(false);
    // Every live plist exists on disk with a sane body.
    for (const path of [mainPath, hbPath, tkPath]) {
      const body = await readFile(path, "utf8");
      expect(body).toContain('<?xml version="1.0"');
      expect(body).toContain("<key>Label</key>");
    }

    // The launchctl call sequence is: bootout(label) × 3 (idempotent
    // pre-cleanup), bootstrap(plist) × 3, then a bootout of every retired
    // identity. The retired ones are booted out even with no plist on disk:
    // launchd keeps a loaded job in the domain until it is booted out, so a
    // hand-deleted plist can still leave a live pre-#435 agent running.
    const sequence = lc.calls.map((c) => c.join(" "));
    expect(sequence).toEqual([
      `bootout gui/501/${phantombotPlistLabel()}`,
      `bootout gui/501/${heartbeatPlistLabel()}`,
      `bootout gui/501/${tickPlistLabel()}`,
      `bootstrap gui/501 ${mainPath}`,
      `bootstrap gui/501 ${hbPath}`,
      `bootstrap gui/501 ${tkPath}`,
      ...RETIRED_PLIST_LABELS.map((l) => `bootout gui/501/${l}`),
    ]);
    expect(out.text).toContain("bootstrapped");
  });

  test("boots out and deletes a nightly plist left by an older install", async () => {
    // Upgrade path: the retired 02:00 agent is still loaded and on disk.
    // Install must unload and delete it, or macOS keeps firing a duplicate
    // sweep every night.
    await Bun.write(ngPath, "<plist>old nightly</plist>");
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await installPhantombotPlists({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(true);
    expect(existsSync(ngPath)).toBe(false);
    expect(lc.calls.map((c) => c.join(" "))).toContain(
      `bootout gui/501/${NIGHTLY_PLIST_LABEL}`,
    );
    expect(out.text).toContain("removed retired plist");
  });

  test("boots out and deletes every pre-#435 host-global agent on upgrade", async () => {
    // The real upgrade shape: a Mac that ran the shared layout has all three
    // legacy agents loaded and on disk. Leaving even one means the old daemon
    // keeps running beside the persona-scoped one, both holding the same
    // database — the exact collision the persona boundary exists to end.
    const dir = dirname(ngPath);
    const legacy = RETIRED_PLIST_LABELS.map((l) => join(dir, `${l}.plist`));
    for (const p of legacy) await Bun.write(p, "<plist>old</plist>");

    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await installPhantombotPlists({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(true);

    const calls = lc.calls.map((c) => c.join(" "));
    for (const label of RETIRED_PLIST_LABELS) {
      expect(calls).toContain(`bootout gui/501/${label}`);
    }
    for (const p of legacy) expect(existsSync(p)).toBe(false);
    // The persona-scoped agents are the ones left standing.
    for (const p of [mainPath, hbPath, tkPath]) expect(existsSync(p)).toBe(true);
  });

  test("fails install (and reports) when bootstrap returns non-zero", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    // 3 bootouts succeed; first bootstrap fails.
    lc.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 5, stdout: "", stderr: "Input/output error" },
    ];
    const result = await installPhantombotPlists({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(false);
    expect(err.text).toContain("launchctl bootstrap");
    expect(err.text).toContain("Input/output error");
  });
});

describe("uninstallPhantombotPlists", () => {
  test("boots out each label then removes the plists from disk", async () => {
    // Pre-create plists so the uninstall has files to remove.
    await Bun.write(mainPath, "<plist></plist>");
    await Bun.write(hbPath, "<plist></plist>");
    await Bun.write(ngPath, "<plist></plist>");
    await Bun.write(tkPath, "<plist></plist>");

    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await uninstallPhantombotPlists({
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.removed).toBe(true);

    expect(lc.calls.map((c) => c.join(" "))).toEqual([
      `bootout gui/501/${tickPlistLabel()}`,
      `bootout gui/501/${heartbeatPlistLabel()}`,
      `bootout gui/501/${phantombotPlistLabel()}`,
      ...RETIRED_PLIST_LABELS.map((l) => `bootout gui/501/${l}`),
    ]);
    // All plists removed.
    expect(existsSync(mainPath)).toBe(false);
    expect(existsSync(hbPath)).toBe(false);
    expect(existsSync(ngPath)).toBe(false);
    expect(existsSync(tkPath)).toBe(false);
    expect(out.text).toContain("removed");
  });

  test("logs '(no plist at …)' for the main plist when nothing was installed", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    // Even bootouts of nothing return non-zero — make sure we don't fail.
    lc.responses = [
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
    ];
    const result = await uninstallPhantombotPlists({
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.removed).toBe(true);
    expect(out.text).toContain("(no plist at");
    // bootout failures are logged but don't fail the uninstall.
    expect(out.text).toContain("returned 1 (continuing)");
  });
});

describe("persona-scoped agents (#435)", () => {
  test("two personas get different labels, so bootstrap/bootout cannot collide", () => {
    // launchd keys everything — bootstrap, bootout, log paths — off the label,
    // so the label IS the isolation boundary on macOS.
    expect(phantombotPlistLabel("lena")).toBe("dev.phantombot.lena.phantombot");
    expect(phantombotPlistLabel("kai")).not.toBe(phantombotPlistLabel("lena"));
    expect(heartbeatPlistLabel("lena")).toBe("dev.phantombot.lena.heartbeat");
    expect(tickPlistLabel("lena")).toBe("dev.phantombot.lena.tick");
  });

  test("a label with a path separator cannot escape the LaunchAgents directory", () => {
    expect(phantombotPlistLabel("../evil")).toBe("dev.phantombot.___evil.phantombot");
  });

  test("the plist exports PHANTOMBOT_PERSONA so the agent resolves its own store", () => {
    const plist = generatePhantombotPlist({
      binPath: "/usr/local/bin/phantombot",
      args: ["run"],
      persona: "lena",
    });
    expect(plist).toContain("<key>PHANTOMBOT_PERSONA</key>");
    expect(plist).toContain("<string>lena</string>");
  });
});


/**
 * Fake launchctl that models the gui domain: which labels are loaded, so
 * `print` can answer truthfully and `bootstrap`/`bootout` mutate it. The
 * plain FakeLaunchctl above always exits 0, which cannot distinguish "already
 * loaded" from "never loaded" — the exact state the post-upgrade reconcile
 * turns on.
 */
class DomainLaunchctl implements LaunchctlRunner {
  calls: string[][] = [];
  loaded: Set<string>;
  /**
   * Labels whose `bootstrap` should fail, modelling the real launchd failure
   * modes the reconcile has to survive: a malformed plist body, a label
   * already claimed in another domain, or a transient launchd error. A fake
   * that always exits 0 cannot express this, which is exactly why the missing
   * guard went unnoticed.
   */
  failBootstrapFor: Set<string>;
  constructor(loaded: string[] = [], failBootstrapFor: string[] = []) {
    this.loaded = new Set(loaded);
    this.failBootstrapFor = new Set(failBootstrapFor);
  }
  async run(args: readonly string[]): Promise<LaunchctlResult> {
    this.calls.push([...args]);
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    const fail = { exitCode: 3, stdout: "", stderr: "No such process" };
    const [verb, a, b] = args;
    const labelOf = (target?: string) => (target ?? "").split("/").pop() ?? "";
    if (verb === "print") return this.loaded.has(labelOf(a)) ? ok : fail;
    if (verb === "bootout") {
      const label = labelOf(a);
      if (!this.loaded.has(label)) return fail;
      this.loaded.delete(label);
      return ok;
    }
    if (verb === "bootstrap") {
      // b is a plist path; its basename minus .plist is the label.
      const label = (b ?? "").split("/").pop()?.replace(/\.plist$/, "") ?? "";
      if (this.failBootstrapFor.has(label)) {
        return {
          exitCode: 5,
          stdout: "",
          stderr: "Load failed: 5: Input/output error",
        };
      }
      this.loaded.add(label);
      return ok;
    }
    return ok;
  }
  get callLines(): string[] {
    return this.calls.map((c) => c.join(" "));
  }
}

describe("ensureLaunchdAgentsCurrent (unattended macOS reconcile)", () => {
  const BIN = "/Users/andrew/.local/bin/phantombot";
  const overrides = () => ({
    plistPath: mainPath,
    heartbeatPlistPath: hbPath,
    tickPlistPath: tkPath,
    nightlyPlistPath: ngPath,
  });

  test("post-upgrade box with only pre-#435 agents ends up scoped and clean, with no reinstall", async () => {
    // Exactly the shape of a Mac that upgraded in place: the three legacy
    // host-global agents are loaded and on disk, and NOTHING under the new
    // persona-scoped labels exists. This is the state `phantombot update`
    // leaves behind, and the reason restart/logs broke until #436.
    const dir = dirname(ngPath);
    const legacy = RETIRED_PLIST_LABELS.map((l) => join(dir, `${l}.plist`));
    for (const p of legacy) await Bun.write(p, "<plist>old</plist>");
    const lc = new DomainLaunchctl([...RETIRED_PLIST_LABELS]);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    // Scoped plists written AND actually live in the domain.
    for (const p of [mainPath, hbPath, tkPath]) expect(existsSync(p)).toBe(true);
    for (const label of [
      phantombotPlistLabel(),
      heartbeatPlistLabel(),
      tickPlistLabel(),
    ]) {
      expect(lc.loaded.has(label)).toBe(true);
      expect(r.reloaded).toContain(label);
    }
    // Nothing pre-#435 left loaded or on disk.
    for (const label of RETIRED_PLIST_LABELS) {
      expect(lc.loaded.has(label)).toBe(false);
      expect(lc.callLines).toContain(`bootout gui/501/${label}`);
    }
    for (const p of legacy) expect(existsSync(p)).toBe(false);
    expect(r.removedRetired.length).toBe(RETIRED_PLIST_LABELS.length);
    expect(r.rewrote.length).toBe(3);
  });

  test("is idempotent: a healthy box is neither rewritten nor reloaded", async () => {
    await Bun.write(mainPath, generatePhantombotPlist({ binPath: BIN, args: ["run"] }));
    await Bun.write(hbPath, generateHeartbeatPlist(BIN));
    await Bun.write(tkPath, generateTickPlist(BIN));
    const lc = new DomainLaunchctl([
      phantombotPlistLabel(),
      heartbeatPlistLabel(),
      tickPlistLabel(),
    ]);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    expect(r.rewrote).toEqual([]);
    expect(r.reloaded).toEqual([]);
    expect(r.removedRetired).toEqual([]);
    expect(lc.callLines.some((c) => c.startsWith("bootstrap"))).toBe(false);
  });

  test("a plist left over from an older binary is rewritten and reloaded", async () => {
    await Bun.write(mainPath, generatePhantombotPlist({ binPath: "/old/phantombot", args: ["run"] }));
    await Bun.write(hbPath, generateHeartbeatPlist(BIN));
    await Bun.write(tkPath, generateTickPlist(BIN));
    const lc = new DomainLaunchctl([
      phantombotPlistLabel(),
      heartbeatPlistLabel(),
      tickPlistLabel(),
    ]);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    expect(r.rewrote).toEqual([`${phantombotPlistLabel()}.plist`]);
    expect(r.reloaded).toEqual([phantombotPlistLabel()]);
    expect(await readFile(mainPath, "utf8")).toContain(`<string>${BIN}</string>`);
    expect(existsSync(`${mainPath}.bak`)).toBe(true);
  });

  test("a scoped plist that is on disk but not loaded gets bootstrapped", async () => {
    // The reinstall-less upgrade path can leave a correct plist that launchd
    // has never been told about; only `print` distinguishes it from healthy.
    await Bun.write(mainPath, generatePhantombotPlist({ binPath: BIN, args: ["run"] }));
    await Bun.write(hbPath, generateHeartbeatPlist(BIN));
    await Bun.write(tkPath, generateTickPlist(BIN));
    const lc = new DomainLaunchctl([heartbeatPlistLabel(), tickPlistLabel()]);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    expect(r.rewrote).toEqual([]);
    expect(r.reloaded).toEqual([phantombotPlistLabel()]);
    expect(lc.loaded.has(phantombotPlistLabel())).toBe(true);
  });

  test("scoped agents are live BEFORE the retired ones are booted out", async () => {
    // Ordering matters: sweeping the old daemon first would leave a window
    // (and, if a bootstrap fails, a permanent state) with no daemon at all.
    const dir = dirname(ngPath);
    for (const l of RETIRED_PLIST_LABELS) {
      await Bun.write(join(dir, `${l}.plist`), "<plist>old</plist>");
    }
    const lc = new DomainLaunchctl([...RETIRED_PLIST_LABELS]);
    await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });
    const lines = lc.callLines;
    const lastBootstrap = lines.findLastIndex((c) => c.startsWith("bootstrap"));
    const firstLegacyBootout = lines.findIndex((c) =>
      RETIRED_PLIST_LABELS.some((l) => c === `bootout gui/501/${l}`),
    );
    expect(lastBootstrap).toBeGreaterThan(-1);
    expect(firstLegacyBootout).toBeGreaterThan(lastBootstrap);
  });

  test("every scoped bootstrap failing leaves the retired agents LOADED and on disk", async () => {
    // The failure this guards: an upgraded Mac where the new plists cannot be
    // loaded at all. Sweeping anyway would boot out and DELETE the only agents
    // still running, so the box would have no daemon, no heartbeat and no tick
    // — and no plist to recover from. Leaving the old ones is recoverable.
    const dir = dirname(ngPath);
    const legacy = RETIRED_PLIST_LABELS.map((l) => join(dir, `${l}.plist`));
    for (const p of legacy) await Bun.write(p, "<plist>old</plist>");
    const scoped = [
      phantombotPlistLabel(),
      heartbeatPlistLabel(),
      tickPlistLabel(),
    ];
    const lc = new DomainLaunchctl([...RETIRED_PLIST_LABELS], scoped);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    // The failure is SURFACED, with launchctl's own error, not swallowed.
    expect(r.failures.map((f) => f.label).sort()).toEqual([...scoped].sort());
    for (const f of r.failures) expect(f.error).toContain("Input/output error");
    expect(r.reloaded).toEqual([]);

    // Nothing was swept: retired agents still loaded AND still on disk.
    expect(r.removedRetired).toEqual([]);
    for (const label of RETIRED_PLIST_LABELS) {
      expect(lc.loaded.has(label)).toBe(true);
      expect(lc.callLines).not.toContain(`bootout gui/501/${label}`);
    }
    for (const p of legacy) expect(existsSync(p)).toBe(true);
  });

  test("a partial failure also blocks the sweep", async () => {
    // Two of three agents load. The box is still not converged, so the retired
    // identities stay — a half-migrated Mac must not lose its old daemon.
    const dir = dirname(ngPath);
    const legacy = RETIRED_PLIST_LABELS.map((l) => join(dir, `${l}.plist`));
    for (const p of legacy) await Bun.write(p, "<plist>old</plist>");
    const lc = new DomainLaunchctl([...RETIRED_PLIST_LABELS], [tickPlistLabel()]);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    expect(r.failures.map((f) => f.label)).toEqual([tickPlistLabel()]);
    expect(r.reloaded).toEqual([phantombotPlistLabel(), heartbeatPlistLabel()]);
    expect(r.removedRetired).toEqual([]);
    for (const p of legacy) expect(existsSync(p)).toBe(true);
  });

  test("a drifted-but-healthy agent that fails to reload is restored and re-bootstrapped", async () => {
    // The nastiest sub-case: the agent was RUNNING fine, we booted it out to
    // apply a new body, and the new body will not load. Doing nothing leaves a
    // working agent permanently down. Put the old plist back and reload it.
    const oldBody = generatePhantombotPlist({ binPath: "/old/phantombot", args: ["run"] });
    await Bun.write(mainPath, oldBody);
    await Bun.write(hbPath, generateHeartbeatPlist(BIN));
    await Bun.write(tkPath, generateTickPlist(BIN));
    const lc = new DomainLaunchctl(
      [phantombotPlistLabel(), heartbeatPlistLabel(), tickPlistLabel()],
      [],
    );
    // Fail only the FIRST bootstrap of the main label; the restore attempt
    // (second bootstrap of the same label) must succeed.
    let mainBootstraps = 0;
    const inner = lc.run.bind(lc);
    lc.run = async (args: readonly string[]) => {
      if (args[0] === "bootstrap" && (args[2] ?? "").endsWith(`${phantombotPlistLabel()}.plist`)) {
        mainBootstraps += 1;
        if (mainBootstraps === 1) {
          lc.calls.push([...args]);
          return { exitCode: 5, stdout: "", stderr: "Load failed: 5: Input/output error" };
        }
      }
      return inner(args);
    };

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    // The agent is back UP, running the previous body.
    expect(lc.loaded.has(phantombotPlistLabel())).toBe(true);
    expect(await readFile(mainPath, "utf8")).toBe(oldBody);
    expect(r.rolledBack).toEqual([phantombotPlistLabel()]);
    // And we do not claim to have rewritten a plist we put back.
    expect(r.rewrote).toEqual([]);
    // Still a failure, so the sweep is still skipped.
    expect(r.failures.map((f) => f.label)).toEqual([phantombotPlistLabel()]);
    expect(r.removedRetired).toEqual([]);
  });

  test("a fully healthy reconcile still sweeps — the guard does not block the happy path", async () => {
    // Guards that skip too much are as bad as guards that skip too little.
    const dir = dirname(ngPath);
    const legacy = RETIRED_PLIST_LABELS.map((l) => join(dir, `${l}.plist`));
    for (const p of legacy) await Bun.write(p, "<plist>old</plist>");
    const lc = new DomainLaunchctl([...RETIRED_PLIST_LABELS]);

    const r = await ensureLaunchdAgentsCurrent({
      binPath: BIN,
      domain: "gui/501",
      launchctl: lc,
      ...overrides(),
    });

    expect(r.failures).toEqual([]);
    expect(r.rolledBack).toEqual([]);
    expect(r.removedRetired.length).toBe(RETIRED_PLIST_LABELS.length);
    for (const p of legacy) expect(existsSync(p)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dynamicContextExtensionDir,
  dynamicContextExtensionStatus,
  ensureDynamicContextExtension,
} from "../src/lib/piDynamicContextProvision.ts";

let home: string;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("dynamic Pi context extension provisioning", () => {
  test("stamps the always-on extension and detects a clean state", async () => {
    home = await mkdtemp(join(tmpdir(), "phantombot-dynamic-context-"));
    const result = await ensureDynamicContextExtension({ home });
    expect(result.action).toBe("created");
    expect(await dynamicContextExtensionStatus({ home })).toEqual({
      present: true,
      drifted: false,
      dir: dynamicContextExtensionDir(home),
    });
    expect(await readFile(join(dynamicContextExtensionDir(home), "index.ts"), "utf8"))
      .toContain("MANAGED BY PHANTOMBOT");
  });

  test("repairs a changed source file", async () => {
    home = await mkdtemp(join(tmpdir(), "phantombot-dynamic-context-"));
    await ensureDynamicContextExtension({ home });
    const index = join(dynamicContextExtensionDir(home), "index.ts");
    await Bun.write(index, "// tampered\n");
    expect((await dynamicContextExtensionStatus({ home })).drifted).toBe(true);
    expect((await ensureDynamicContextExtension({ home })).action).toBe("updated");
    expect(await readFile(index, "utf8")).toContain("MANAGED BY PHANTOMBOT");
  });
});


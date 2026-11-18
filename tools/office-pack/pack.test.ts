import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { EngineManifestSchema, OFFICE_OPERATIONS } from "@hns/core/office";
import * as v from "valibot";

// The pack's contract without building it: what build.sh and verify.sh promise, checked against
// the same schema the machine validates a loaded manifest with (0236), plus the shapes the tests
// below inject faults into. Building the pack needs the network and a Nix host, so that half lives
// in office-pack.integration.test.ts and skips honestly when the host cannot do it.

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const read = (name: string): string => readFileSync(here(name), "utf8");

// Catches: listing an operation the v0.8.7 binary cannot produce (§11 says preview/render/convert
// only until the sidecar exists), or naming a licence file the distribution does not carry.
test("the manifest build.sh writes has the §11 shape", () => {
  const pack = read("pack.mjs");
  const operations = /const OPERATIONS = \[(.*?)\];/s.exec(pack)?.[1] ?? "";
  expect(operations.replace(/["\s]/g, "").split(",")).toStrictEqual([
    "preview",
    "render",
    "convert",
  ]);
  for (const operation of operations.replace(/["\s]/g, "").split(",")) {
    expect(OFFICE_OPERATIONS).toContain(operation);
  }
  expect(pack).toContain('license: { spdx: SPDX, notice: "NOTICE", source: "SOURCE.md" }');
  expect(pack).toContain('const SPDX = "AGPL-3.0-only";');
  expect(pack).toContain("runtime: {");
  // The runtime's out-of-pack dependencies are declared with a path and a digest, never searched.
  expect(pack).toContain("bindPaths: [{");
  expect(pack).toContain('kind: "icd",');
});

// Catches: a pack that "works" by reading whatever the build host happens to have, instead of the
// versions build.sh pins. Every fetch is digest-checked before anything is unpacked.
test("every fetched input is pinned to a sha256", () => {
  const build = read("build.sh");
  for (const name of ["IPAEX", "NOTO_SANS_JP", "DEJAVU"]) {
    const digest = new RegExp(name + '_SHA256="([0-9a-f]{64})"').exec(build)?.[1];
    expect(digest, name + "_SHA256").toBeDefined();
    expect(new RegExp(name + "_URL=").test(build)).toBe(true);
  }
  const appimage = /IBIS_OFFICE_SHA256="\$\{IBIS_OFFICE_SHA256:-([0-9a-f]{64})\}"/.exec(build)?.[1];
  // The value the spike measured and GitHub publishes for the v0.8.7 asset.
  expect(appimage).toBe("0c6b15d93b285cd87fece776ea6be0d79d826c8888f2864dc7f02033330085dd");
  expect(build).toContain('readonly IBIS_OFFICE_VERSION="0.8.7"');
});

// Catches: a build that skips the digest check and trusts whatever arrived.
test("build.sh refuses a file whose digest differs before it unpacks it", () => {
  const build = read("build.sh");
  const guard = /if \[\[ "\$got" != "\$digest" \]\]; then[\s\S]*?die[^\n]*\n\s*fi/.exec(build);
  expect(guard).not.toBeNull();
});

// Catches: verify.sh reporting "ok" while checking only the binary, so a stale library or a
// removed notice passes.
test("verify.sh checks every manifested file, extra files, and the licence pieces", () => {
  const pack = read("pack.mjs");
  const verify = /const verify = \(\) => \{[\s\S]*?\n\};/.exec(pack)?.[0] ?? "";
  expect(verify).toContain("for (const [path, digest] of Object.entries(files))");
  expect(verify).toContain("is in the pack but not in the manifest");
  expect(verify).toContain('["LICENSE", "NOTICE", "SOURCE.md", "About.txt"]');
  expect(verify).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
});

// Catches: a render preflight that decides "available" by searching the host, which is the
// behaviour the sandbox's fixed bind list exists to avoid.
test("the render preflight reads paths from the manifest and searches nothing", () => {
  const pack = read("pack.mjs");
  // The decision itself lives in reachable(), which reads the manifest and nothing else.
  const reachableFn = /const reachable = \(pack, value\) => \{[\s\S]*?\n\};/.exec(pack)?.[0] ?? "";
  expect(reachableFn).toContain("value.build?.runtime?.bindPaths");
  expect(reachableFn).toContain("VK_ICD_FILENAMES");
  expect(reachableFn).not.toMatch(/readdirSync|scandir|readdir\(/);
  expect(reachableFn).toContain("Vulkan driver not found at");
  expect(reachableFn).toContain("bound.has(driver)");
  expect(reachableFn).not.toContain("existsSync(entry.path)");
});

describe("a hand-made pack", () => {
  const root = mkdtempSync(join(tmpdir(), "hns-office-pack-"));
  const pack = join(root, "pack");
  // The literal is the whole truth: its keys are the files a hand-made pack carries.
  const content = {
    "bin/ibisOffice": "foo",
    LICENSE: "GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007",
    NOTICE: "notice",
    "SOURCE.md": "source",
    "About.txt": "about",
  } satisfies Record<string, string>;
  const digestsOf = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(content).map(([path, body]) => [
        path,
        "sha256:" + createHash("sha256").update(body).digest("hex"),
      ]),
    );
  const manifest = {
    id: "ibisoffice",
    version: "0.8.7",
    capabilities: {
      formats: ["docx", "xlsx", "pptx"],
      operations: ["preview", "render", "convert"],
    },
    license: { spdx: "AGPL-3.0-only", notice: "NOTICE", source: "SOURCE.md" },
    build: {
      runtime: { bindPaths: [] },
      environment: { VK_ICD_FILENAMES: "share/vulkan/icd.d/lvp_icd.x86_64.json" },
    },
  };
  const render = (): { available: boolean; reason?: string } => {
    try {
      return JSON.parse(
        execFileSync(process.execPath, [here("pack.mjs"), "render", "--pack", pack], {
          encoding: "utf8",
        }),
      );
    } catch (error) {
      // execFileSync throws with the child's stdout attached, and render answers with JSON there in
      // every case that exits non-zero. Anything else is not an answer, and parsing it fails loudly.
      const stdout = error instanceof Error && "stdout" in error ? error.stdout : "";
      return JSON.parse(String(stdout));
    }
  };
  const layout = (bindPaths: readonly unknown[]): void => {
    rmSync(pack, { recursive: true, force: true });
    mkdirSync(join(pack, "share/vulkan/icd.d"), { recursive: true });
    for (const [path, body] of Object.entries(content)) {
      mkdirSync(join(pack, path, ".."), { recursive: true });
      writeFileSync(join(pack, path), body);
    }
    mkdirSync(join(pack, "lib"), { recursive: true });
    writeFileSync(
      join(pack, "share/vulkan/icd.d/lvp_icd.x86_64.json"),
      JSON.stringify({ ICD: { library_path: "/nix/store/abc-mesa/lib/libvulkan_lvp.so" } }),
    );
    writeFileSync(
      join(pack, "manifest.json"),
      JSON.stringify({
        ...manifest,
        files: digestsOf(),
        build: { ...manifest.build, runtime: { bindPaths } },
      }),
    );
  };
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the manifest shape is what the machine will validate", () => {
    layout([]);
    const onDisk = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
    const check = v.safeParse(EngineManifestSchema, {
      id: onDisk.id,
      version: onDisk.version,
      capabilities: onDisk.capabilities,
      license: onDisk.license,
      files: onDisk.files,
    });
    expect(check.success).toBe(true);
    if (!check.success) return;
    expect(check.output.license.spdx).toBe("AGPL-3.0-only");
    expect(check.output.capabilities.operations).toStrictEqual(["preview", "render", "convert"]);
  });

  // C1/C2/C5 at the level of verify.sh: a digest that no longer matches, a notice that is gone,
  // and a file nobody recorded all make the pack unusable instead of silently usable.
  test("verify refuses a pack whose binary changed, whose notice moved, or which holds an extra file", () => {
    layout([]);
    // A pack the hand-made manifest fully accounts for passes; each fault below is what verify is
    // for, so the passing case has to come first.
    const stray = join(pack, "share/vulkan/icd.d/lvp_icd.x86_64.json");
    content["share/vulkan/icd.d/lvp_icd.x86_64.json"] = readFileSync(stray, "utf8");
    layout([]);
    execFileSync(here("verify.sh"), [pack]);
    writeFileSync(join(pack, "bin/ibisOffice"), "foo!");
    expect(() => execFileSync(here("verify.sh"), [pack], { stdio: "pipe" })).toThrow();
    layout([]);
    rmSync(join(pack, "NOTICE"));
    expect(() => execFileSync(here("verify.sh"), [pack], { stdio: "pipe" })).toThrow();
    layout([]);
    writeFileSync(join(pack, "stray.so"), "not recorded");
    expect(() => execFileSync(here("verify.sh"), [pack], { stdio: "pipe" })).toThrow();
  });

  // The driver the ICD names is in no pack file here: render must say so, naming the path, instead
  // of reporting available (or falling back to whatever the host has).
  test("render is unavailable, with the path in the reason, when the driver is not reachable", () => {
    layout([]);
    expect(render()).toStrictEqual({
      available: false,
      reason: "Vulkan driver not found at /nix/store/abc-mesa/lib/libvulkan_lvp.so",
    });
  });

  // A bind is a path the machine will make visible, not a claim about this host: a declared entry
  // counts even when this host cannot resolve it, and a manifest with neither a declared path nor
  // a carried copy is the case that says "not found" (above).
  test("a declared bind is enough even when this host cannot resolve it yet", () => {
    layout([
      {
        kind: "icd",
        path: "/nix/store/abc-mesa/lib/libvulkan_lvp.so",
        sha256: "sha256:" + "0".repeat(64),
      },
    ]);
    expect(render()).toStrictEqual({ available: true });
    // A relative path is a mistake in the manifest: there is nothing to bind to.
    layout([{ kind: "icd", path: "libvulkan_lvp.so", sha256: "sha256:" + "0".repeat(64) }]);
    expect(render().reason).toContain("bindPaths names a relative path");
  });
  // The paths are the manifest's, not a search: a driver that is a pack file is reachable, and a
  // driver file that is gone is not — even when this host still has the /nix/store path the ICD
  // names. That is the difference between "the pack's driver" and "whatever this machine has".
  test("render follows the manifest and never the host", () => {
    layout([]);
    // The pack carries the driver under lib/store, at the path the ICD names: reachable.
    mkdirSync(join(pack, "lib/store/abc-mesa/lib"), { recursive: true });
    writeFileSync(join(pack, "lib/store/abc-mesa/lib/libvulkan_lvp.so"), "driver");
    const files = {
      ...digestsOf(),
      "lib/store/abc-mesa/lib/libvulkan_lvp.so":
        "sha256:" + createHash("sha256").update("driver").digest("hex"),
    };
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({ ...manifest, files }));
    expect(render()).toStrictEqual({ available: true });
    // Delete it: the file is gone from the pack. This host may still have the store path the ICD
    // names, but that is not the pack's answer — the reason names the path it looked for.
    rmSync(join(pack, "lib/store/abc-mesa/lib/libvulkan_lvp.so"));
    const absent = render();
    expect(absent.available).toBe(false);
    expect(absent.reason).toContain("/nix/store/abc-mesa/lib/libvulkan_lvp.so");
  });
});

test("the fixture document the smoke test renders is in the repository", () => {
  const fixture = here("test/fixtures/ja.docx");
  expect(existsSync(fixture)).toBe(true);
  expect(readFileSync(fixture).subarray(0, 2).toString()).toBe("PK");
});

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  // files is byte payload that EngineManifestSchema validates: values are digests, never objects.
  // Links are their own list, under build, where the schema does not look.
  expect(/files\[entry\.path\] = "sha256:" \+ sha256/.test(pack)).toBe(true);
  expect(pack).toContain("symlinks.push({ path: entry.path, target: entry.target");
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

// Catches: a build that skips the digest check and trusts whatever arrived — and one that reports
// a moved upstream or a torn download as a digest mismatch, or the other way round (0235 NB4).
test("build.sh checks the digest before unpacking, and says which fault it saw", () => {
  const build = read("build.sh");
  // A failed download stops with its own message; nothing is hashed, nothing is unpacked.
  const download = build.slice(build.indexOf("  curl -fsSL"), build.indexOf("  local got"));
  expect(download).toContain("could not download");
  // A download whose digest differs says so, names both digests, and is removed before any use.
  const guard =
    /if \[\[ "\$got" != "\$digest" \]\]; then[\s\S]*?die "([^"]*)"[\s\S]*?mv "\$dest\.part" "\$dest"/.exec(
      build,
    );
  expect(guard).not.toBeNull();
  const message = guard?.[1] ?? "";
  expect(message).toContain("sha256");
  expect(message).toContain("refusing to unpack");
  expect(message).not.toContain("could not download");
  // The mismatch branch removes the partial file before dying, so a later run cannot pick it up.
  expect(/rm -f "\$dest\.part"\n\s*die "downloaded/.test(build)).toBe(true);
});

// Catches: verify.sh reporting "ok" while checking only the binary, so a stale library or a
// removed notice passes.
test("verify.sh checks every manifested file, extra files, and the licence pieces", () => {
  const pack = read("pack.mjs");
  const verify = /const verify = \(\) => \{[\s\S]*?\n\};/.exec(pack)?.[0] ?? "";
  expect(verify).toContain("for (const [path, digest] of Object.entries(files))");
  expect(verify).toContain("is in the pack but not in the manifest");
  // A link holds no bytes, so it is not in files: the links are checked from build.symlinks, where
  // the target is compared, the resolution must stay inside the pack, and the bytes are pinned.
  expect(verify).toContain("for (const link of value.build?.symlinks ?? [])");
  expect(verify).toContain("resolvesInside(pack, target)");
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
  // The digest is part of every bind: a shape check that always runs, and a value check when the
  // file is here. That is the difference between "declared" and "claimed".
  expect(reachableFn).toContain("OFFICE_DIGEST.test(entry.sha256)");
  expect(reachableFn).toContain("is not the file the manifest names");
});

describe("a hand-made pack", () => {
  const root = mkdtempSync(join(tmpdir(), "hns-office-pack-"));
  const pack = join(root, "pack");
  // The files a hand-made pack carries, and nothing else.
  const content = new Map<string, string>([
    ["bin/ibisOffice", "foo"],
    ["LICENSE", "GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007"],
    ["NOTICE", "notice"],
    ["SOURCE.md", "source"],
    ["About.txt", "about"],
  ]);
  const digestsOf = (files: ReadonlyMap<string, string> = content): Record<string, string> =>
    Object.fromEntries(
      [...files].map(([path, body]) => [
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
    // The ICD names a driver at the path where the machine's store would be, and is part of the
    // pack like any other file, so the manifest accounts for all of it.
    const files = new Map(content);
    files.set(
      "share/vulkan/icd.d/lvp_icd.x86_64.json",
      JSON.stringify({ ICD: { library_path: "/nix/store/abc-mesa/lib/libvulkan_lvp.so" } }),
    );
    for (const [path, body] of files) {
      mkdirSync(join(pack, dirname(path)), { recursive: true });
      writeFileSync(join(pack, path), body);
    }
    mkdirSync(join(pack, "lib"), { recursive: true });
    writeFileSync(
      join(pack, "manifest.json"),
      JSON.stringify({
        ...manifest,
        files: digestsOf(files),
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
    // A pack the hand-made manifest fully accounts for passes; each fault below is what verify is
    // for, so the passing case has to come first.
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

  // A bind is a claim the machine acts on, so every part of it is checked: the path is absolute,
  // the digest is a digest, and when the file is here it is the file named. A path this host cannot
  // resolve yet is the one case that is allowed through — that is what the bind is for.
  test("a bind must carry a well-formed digest, and a wrong digest is refused", () => {
    const driver = join(root, "driver.so");
    writeFileSync(driver, "driver");
    const digest = "sha256:" + createHash("sha256").update("driver").digest("hex");
    // The ICD names the pack's own copy; the binds below are what stands that copy up. A driver this
    // host cannot resolve yet is allowed, because the machine will bind it.
    mkdirSync(join(pack, "lib/store/abc-mesa/lib"), { recursive: true });
    writeFileSync(join(pack, "lib/store/abc-mesa/lib/libvulkan_lvp.so"), "driver");
    const copy = "sha256:" + createHash("sha256").update("driver").digest("hex");
    const withCopy = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
    withCopy.files["lib/store/abc-mesa/lib/libvulkan_lvp.so"] = copy;
    writeFileSync(join(pack, "manifest.json"), JSON.stringify(withCopy));
    expect(render()).toStrictEqual({ available: true });
    // A digest that is not a digest is never a bind.
    withCopy.build.runtime.bindPaths = [{ kind: "icd", path: driver, sha256: "not-even-a-digest" }];
    writeFileSync(join(pack, "manifest.json"), JSON.stringify(withCopy));
    expect(render().reason).toContain("has no sha256 in the manifest");
    // A file that is here but is not the file named is refused, not trusted.
    withCopy.build.runtime.bindPaths = [
      { kind: "icd", path: driver, sha256: "sha256:" + "0".repeat(64) },
    ];
    writeFileSync(join(pack, "manifest.json"), JSON.stringify(withCopy));
    expect(render().reason).toContain("is not the file the manifest names");
    // The same file with its real digest is a bind; the copy alone is enough.
    withCopy.build.runtime.bindPaths = [{ kind: "icd", path: driver, sha256: digest }];
    writeFileSync(join(pack, "manifest.json"), JSON.stringify(withCopy));
    expect(render()).toStrictEqual({ available: true });
    delete withCopy.files["lib/store/abc-mesa/lib/libvulkan_lvp.so"];
    rmSync(join(pack, "lib/store/abc-mesa/lib/libvulkan_lvp.so"));
    // Nothing carried and nothing verified: not reachable, by name.
    expect(render().reason).toContain("/nix/store/abc-mesa/lib/libvulkan_lvp.so");
    // A relative path is a mistake in the manifest: there is nothing to bind to.
    withCopy.build.runtime.bindPaths = [{ kind: "icd", path: "libvulkan_lvp.so", sha256: digest }];
    writeFileSync(join(pack, "manifest.json"), JSON.stringify(withCopy));
    expect(render().reason).toContain("bindPaths names a relative path");
  });
  // The store/ tree is symlinks, and a symlink is payload: verify reads the link it finds, not the
  // file the manifest once recorded. Re-pointing one at a host file is a different pack.
  // The links are checked from build.symlinks, and all four ways a link can lie are caught: its
  // target moved, the manifest moved with it to match, the bytes behind it changed, and a link the
  // manifest never listed.
  // The links are checked from build.symlinks, and every way a link can lie is caught: its target
  // moved, the manifest moved with it to match, the bytes behind it changed, and a link the
  // manifest never listed.
  test("verify reads build.symlinks: target, containment, content, and extras", () => {
    layout([]);
    const manifestPath = join(pack, "manifest.json");
    const base = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(join(pack, "lib/libx.so.1"), "library");
    mkdirSync(join(pack, "store/x/lib"), { recursive: true });
    const link = join(pack, "store/x/lib/libx.so.1");
    const target = "../../../lib/libx.so.1";
    const digest = "sha256:" + createHash("sha256").update("library").digest("hex");
    symlinkSync(target, link);
    const files = { ...base.files, "lib/libx.so.1": digest };
    const entry = { path: "store/x/lib/libx.so.1", target, sha256: digest };
    const write = (symlinks: unknown[]) =>
      writeFileSync(
        manifestPath,
        JSON.stringify({ ...base, files, build: { ...base.build, symlinks } }),
      );
    write([entry]);
    execFileSync(here("verify.sh"), [pack]);
    // 1. re-pointed at a host file: not the link the manifest recorded.
    rmSync(link);
    symlinkSync("/etc/passwd", link);
    expect(spawnSync(here("verify.sh"), [pack], { encoding: "utf8" }).stderr).toContain(
      "points at /etc/passwd",
    );
    // 2. the manifest rewritten to agree with a link that leaves the pack: still refused.
    write([{ ...entry, target: "/etc/passwd" }]);
    expect(spawnSync(here("verify.sh"), [pack], { encoding: "utf8" }).stderr).toContain(
      "points outside the pack",
    );
    // 3. the same link, but the bytes behind it changed.
    rmSync(link);
    symlinkSync(target, link);
    write([entry]);
    writeFileSync(join(pack, "lib/libx.so.1"), "library!");
    expect(spawnSync(here("verify.sh"), [pack], { encoding: "utf8" }).stderr).toContain(
      "resolves to sha256:",
    );
    writeFileSync(join(pack, "lib/libx.so.1"), "library");
    // 4. a link the manifest never listed is a file the distribution carries unaccounted for.
    write([]);
    expect(spawnSync(here("verify.sh"), [pack], { encoding: "utf8" }).stderr).toContain(
      "store/x/lib/libx.so.1 is in the pack but not in the manifest",
    );
  });
  // A check that leaves files behind in whatever directory it runs from is a check that changes the
  // thing it inspects (0235 NB6): fonts and verify run in their own temp directory and write nothing
  // in the caller's.
  test("the checks write nothing in the caller's working directory", () => {
    layout([]);
    const cwd = mkdtempSync(join(root, "cwd-"));
    const before = readdirSync(cwd).sort();
    for (const args of [["fonts"], ["verify"]]) {
      spawnSync(process.execPath, [here("pack.mjs"), ...args, "--pack", pack], {
        cwd,
        encoding: "utf8",
      });
    }
    expect(readdirSync(cwd).sort()).toStrictEqual(before);
  });
});

test("the fixture document the smoke test renders is in the repository", () => {
  const fixture = here("test/fixtures/ja.docx");
  expect(existsSync(fixture)).toBe(true);
  expect(readFileSync(fixture).subarray(0, 2).toString()).toBe("PK");
});

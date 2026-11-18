import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The real thing: build the pack from the pinned release, then make it fail in the ways 0235 says it
// must fail visibly (C1–C5, T3). Everything here runs the pack's own scripts and the pack's own
// binary; no machine, no daemon.
//
// It is slow (a 51 MB download the first time, then ~4 s per build) and it needs the network and a
// Nix host with the X11 / Mesa / Vulkan store paths. When they are not there the suite reports the
// skip by name instead of passing quietly; HNS_REQUIRE_OFFICE_PACK=1 makes a missing prerequisite a
// failure, which is how CI turns it on.

const require = process.env.HNS_REQUIRE_OFFICE_PACK === "1";
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const tools = join(root, "tools/office-pack");
const fixture = join(tools, "test/fixtures/ja.docx");
const work = mkdtempSync(join(tmpdir(), "hns-office-pack-it-"));
const cache = process.env.IBIS_OFFICE_CACHE_DIR ?? join(root, ".cache/office-pack");

/** The reason the host cannot run this suite, or undefined when it can. */
const missingPrerequisite = (): string | undefined => {
  const binaries = ["curl", "sha256sum", "unzip", "tar", "node"];
  for (const name of binaries) {
    if (spawnSync("sh", ["-c", "command -v " + name]).status !== 0) return name + " is not on PATH";
  }
  const stores = ["mesa", "vulkan-loader"];
  for (const name of stores) {
    const found = spawnSync("sh", ["-c", "compgen -G '/nix/store/*-" + name + "-*' | head -n 1"], {
      encoding: "utf8",
    });
    if ((found.stdout ?? "").trim() === "") return "no " + name + " in /nix/store";
  }
  const x11 = spawnSync("sh", ["-c", "compgen -G '/nix/store/*/*/libxcb.so.1*' | head -n 1"], {
    encoding: "utf8",
  });
  if ((x11.stdout ?? "").trim() === "") return "no libxcb in /nix/store";
  // fc-list comes from fontconfig, not from the pack; the pack's font check cannot run without it.
  if (spawnSync("fc-list", []).error !== undefined) return "fc-list is not on PATH (fontconfig)";
  // The build reads these from this host's store, by name (build.sh fails with the same names).
  for (const path of ["/run/current-system/sw/bin", "/usr/bin"]) {
    if (existsSync(path) && spawnSync("sh", ["-c", "exit 0"]).status !== 0)
      return path + " is unusable";
  }
  return undefined;
};

const skip = missingPrerequisite();
if (skip !== undefined && require) {
  throw new Error("HNS_REQUIRE_OFFICE_PACK=1 but this host cannot build the pack: " + skip);
}

const build = (name: string): string => {
  const pack = join(work, name);
  execFileSync(join(tools, "build.sh"), [], {
    env: { ...process.env, IBIS_OFFICE_PACK_DIR: pack, IBIS_OFFICE_CACHE_DIR: cache },
    stdio: "pipe",
  });
  return pack;
};

/** The environment the machine (0236) will build from manifest.build.environment. */
const packEnv = (pack: string) => {
  const manifest = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
  const icd = join(pack, manifest.build.environment.VK_ICD_FILENAMES);
  return {
    PATH: "/usr/bin:/bin",
    HOME: join(work, "home"),
    LD_LIBRARY_PATH: join(pack, manifest.build.environment.LD_LIBRARY_PATH),
    FONTCONFIG_FILE: join(pack, manifest.build.environment.FONTCONFIG_FILE),
    FONTCONFIG_PATH: pack,
    VK_ICD_FILENAMES: icd,
    VK_DRIVER_FILES: icd,
  };
};

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the pack's binary the way the machine does: a cleared environment, then the manifest's. */
const run = (
  pack: string,
  operation: "pdf" | "png",
  out: string,
  env?: Record<string, string>,
): Run => {
  mkdirSync(out, { recursive: true });
  const result = spawnSync(
    join(pack, "bin/ibisOffice"),
    ["--export", operation, "--width", "320", "--out-dir", out, fixture],
    {
      env: env ?? packEnv(pack),
      encoding: "utf8",
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** Which fonts the PDF embeds, without a PDF library: an embedded font is a /FontFile stream. */
const embeddedFonts = (pdf: string): readonly string[] => {
  const bytes = readFileSync(pdf);
  const names: string[] = [];
  for (const match of bytes.toString("latin1").matchAll(/\/BaseFont\s*\/([A-Za-z+-]+)/g)) {
    const name = match[1] ?? "";
    if (!name.includes("Identity")) names.push(name.replace(/^[A-Z]{6}\+/, ""));
  }
  return [...new Set(names)];
};

const outputs = (dir: string): readonly string[] =>
  existsSync(dir)
    ? execFileSync("sh", ["-c", "ls -1 " + JSON.stringify(dir)], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line !== "")
    : [];

if (skip !== undefined) process.stderr.write("office-pack skip: " + skip + "\n");
describe.skipIf(skip !== undefined)("the office pack", () => {
  let pack: string;
  beforeAll(() => {
    mkdirSync(join(work, "home"), { recursive: true });
    pack = build("pack");
  }, 600_000);
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  // C1: build.sh's own verify passes, and the manifest names every conveyed file with its digest.
  test("C1: the built pack verifies against its own manifest", () => {
    execFileSync(join(tools, "verify.sh"), [pack]);
    const manifest = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
    expect(manifest.capabilities.operations).toStrictEqual(["preview", "render", "convert"]);
    expect(manifest.license).toStrictEqual({
      spdx: "AGPL-3.0-only",
      notice: "NOTICE",
      source: "SOURCE.md",
    });
    for (const path of [
      "bin/ibisOffice",
      "fonts/ipaexg.ttf",
      "share/vulkan/icd.d/lvp_icd.x86_64.json",
      "LICENSE",
    ]) {
      expect(manifest.files[path], path).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // What the pack does not carry is declared: a path and a digest, resolved when it was built.
    expect(manifest.build.runtime.bindPaths).toStrictEqual([
      {
        kind: "icd",
        path: "/nix/store/3967gykw3wcyq3svf238nk31jlhxnl7c-mesa-26.1.5/lib/libvulkan_lvp.so",
        sha256:
          manifest.files[
            "lib/store/3967gykw3wcyq3svf238nk31jlhxnl7c-mesa-26.1.5/lib/libvulkan_lvp.so"
          ],
      },
    ]);
  });

  // T3: the same inputs produce the same manifest — the pack is reproducible, not "it happened once".
  test("T3: building twice produces the same manifest", () => {
    const again = build("pack-again");
    expect(readFileSync(join(again, "manifest.json"), "utf8")).toBe(
      readFileSync(join(pack, "manifest.json"), "utf8"),
    );
  }, 600_000);

  // The store/ tree is only symlinks; verify reads them, so re-pointing one at a host file is
  // caught (0235 NB2) — which a check that skipped links could not do.
  test("a store symlink re-pointed at a host file fails verify", () => {
    const retargeted = join(work, "retargeted");
    cpSync(pack, retargeted, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(retargeted, "manifest.json"), "utf8"));
    const link = Object.keys(manifest.files).find(
      (path: string) => manifest.files[path].kind === "symlink" && path.endsWith("libvulkan.so.1"),
    );
    expect(link, "the pack lists its store links").toBeDefined();
    const target = join(retargeted, link ?? "");
    rmSync(target);
    symlinkSync("/etc/passwd", target);
    const check = spawnSync(join(tools, "verify.sh"), [retargeted], { encoding: "utf8" });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("points at /etc/passwd");
  });

  // C5: the four AGPL pieces are in the distribution, and verify refuses a pack without them.
  test("C5: LICENSE, NOTICE, SOURCE.md and the About wording ship, and their absence fails the check", () => {
    for (const name of ["LICENSE", "NOTICE", "SOURCE.md", "About.txt"]) {
      expect(statSync(join(pack, name)).size).toBeGreaterThan(0);
    }
    expect(readFileSync(join(pack, "LICENSE"), "utf8")).toContain(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    );
    expect(readFileSync(join(pack, "SOURCE.md"), "utf8")).toContain(
      "0c6b15d93b285cd87fece776ea6be0d79d826c8888f2864dc7f02033330085dd",
    );
    expect(readFileSync(join(pack, "About.txt"), "utf8")).toContain(
      "Rendering by ibisOffice 0.8.7",
    );
    const without = join(work, "no-notice");
    cpSync(pack, without, { recursive: true });
    rmSync(join(without, "NOTICE"));
    expect(() => execFileSync(join(tools, "verify.sh"), [without], { stdio: "pipe" })).toThrow();
  });

  // C2: one byte in the binary and the pack is not one hns may run — verify says so (with digests),
  // and the binary itself no longer starts.
  test("C2: a one-byte change to the binary fails verify and the binary does not start", () => {
    const tampered = join(work, "tampered");
    cpSync(pack, tampered, { recursive: true });
    const binary = join(tampered, "bin/ibisOffice");
    const bytes = readFileSync(binary);
    bytes.writeUInt8(bytes.readUInt8(1000) ^ 0xff, 1000);
    writeFileSync(binary, bytes);
    const check = spawnSync(join(tools, "verify.sh"), [tampered], { encoding: "utf8" });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("bin/ibisOffice is sha256:");
    expect(run(tampered, "pdf", join(work, "out-c2")).status).not.toBe(0);
  });

  // The smoke test the acceptance criterion names: one document, PDF and PNG, from the pack alone.
  test("the pack exports PDF and PNG for one document", () => {
    const pdf = run(pack, "pdf", join(work, "out-pdf"));
    expect(pdf.stderr).toBe("");
    expect(pdf.status).toBe(0);
    expect(outputs(join(work, "out-pdf"))).toStrictEqual(["ja.pdf"]);
    expect(embeddedFonts(join(work, "out-pdf/ja.pdf"))).toContain("IPAexGothic");
    // PNG goes through the sandbox view: the pack and what runtime.bindPaths declares, nothing else.
    const sandboxed = spawnSync(
      process.execPath,
      [
        join(tools, "pack.mjs"),
        "sandbox",
        "--pack",
        pack,
        "--operation",
        "png",
        "--out",
        join(work, "out-png"),
        "--input",
        fixture,
      ],
      { encoding: "utf8" },
    );
    expect(sandboxed.stderr).toBe("");
    expect(sandboxed.status).toBe(0);
    expect(outputs(join(work, "out-png"))).toStrictEqual(["ja-01.png"]);
  }, 120_000);

  // C3: a font the pack no longer carries is not silently replaced. The engine draws with whatever
  // fontconfig has next and says nothing, so the pack's own check (fc-list under the pack's
  // fonts.conf) is what reports it — and the PDF still comes out, with the fallback named. The
  // check reads *which file* answered, not just which families exist, so a fonts.conf that fell
  // back to the host's font for IPAexGothic would not pass as "found".
  test("C3: a removed font still produces a PDF, and the pack's font check names it", () => {
    const withoutFont = join(work, "no-font");
    cpSync(pack, withoutFont, { recursive: true });
    rmSync(join(withoutFont, "fonts/ipaexg.ttf"));
    const pdf = run(withoutFont, "pdf", join(work, "out-c3"));
    expect(pdf.status).toBe(0);
    expect(embeddedFonts(join(work, "out-c3/ja.pdf"))).toContain("NotoSansJP-Regular");
    expect(embeddedFonts(join(work, "out-c3/ja.pdf"))).not.toContain("IPAexGothic");
    const fonts = spawnSync(
      process.execPath,
      [join(tools, "pack.mjs"), "fonts", "--pack", withoutFont],
      {
        encoding: "utf8",
      },
    );
    expect(fonts.status).toBe(2);
    const reported = JSON.parse(fonts.stdout);
    expect(reported.missing).toStrictEqual(["fonts/ipaexg.ttf"]);
    // Every file it claims to have found is one of the pack's own: no host path is ever "found".
    for (const found of reported.found)
      expect(found.file.endsWith(".otf") || found.file.endsWith(".ttf")).toBe(true);
    expect(reported.found.every((found: { file: string }) => !found.file.startsWith(".."))).toBe(
      true,
    );
  }, 120_000);

  // C4: without the software Vulkan driver, PDF succeeds and PNG fails — and the pack says which
  // path is missing before anyone tries, instead of calling render "unsupported".
  test("C4: without the Vulkan driver, PDF succeeds, PNG fails, and render reports the missing path", () => {
    const withoutDriver = join(work, "no-driver");
    cpSync(pack, withoutDriver, { recursive: true });
    // The driver goes, both the pack's copy and the manifest's statement that it can be bound at
    // the /nix/store path the ICD names. The host may still have that store path; neither the
    // render preflight nor the sandbox may use it.
    const manifestPath = join(withoutDriver, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const path of Object.keys(manifest.files)) {
      if (path.startsWith("lib/") && path.includes("vulkan_lvp")) {
        rmSync(join(withoutDriver, path), { force: true });
        delete manifest.files[path];
      }
    }
    manifest.build.runtime.bindPaths = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));

    // preview and convert still work: they do not need the driver.
    expect(run(withoutDriver, "pdf", join(work, "out-c4-pdf")).status).toBe(0);
    // render says "not here", with the path, before anything is attempted.
    const preflight = spawnSync(
      process.execPath,
      [join(tools, "pack.mjs"), "render", "--pack", withoutDriver],
      {
        encoding: "utf8",
      },
    );
    expect(preflight.status).toBe(2);
    const answer = JSON.parse(preflight.stdout);
    expect(answer.available).toBe(false);
    expect(answer.reason).toContain("/nix/store/");
    expect(answer.reason).toContain("libvulkan_lvp.so");
  }, 120_000);
});

// pack.mjs — the parts of the pack build that need a program rather than a shell: the link
// closure, the Vulkan driver manifest, the manifest's digests, and the legal files.
//
// Dependency-free on purpose (node: built-ins only): CI installs nothing to build the pack, and
// the gate's oxfmt/oxlint do not look at tools/*.mjs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The shape of every digest this file writes and reads: `sha256:<64 lowercase hex>`. */
const OFFICE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OPERATIONS = ["preview", "render", "convert"];
/** What the release does not ship and the engine cannot start without (spike S12). */
const SEED_LIBRARIES = ["libxcb.so.1", "libxkbcommon.so.0", "libxkbcommon-x11.so.0"];
/** The C runtime belongs to the host that runs the binary (nix-ld); see libraries(). */
const C_RUNTIME = new Set(["ld-linux-x86-64.so.2", "libc.so.6", "libm.so.6", "libdl.so.2", "librt.so.1", "libpthread.so.0", "libresolv.so.2"]);
const FORMATS = ["docx", "xlsx", "pptx"];
const SPDX = "AGPL-3.0-only";

const args = process.argv.slice(2);
const [command, ...rest] = args;

/** --key value pairs, as given on the command line. */
const option = (name) => {
  const at = rest.indexOf("--" + name);
  return at === -1 ? undefined : rest[at + 1];
};

const fail = (message) => {
  process.stderr.write("office-pack: " + message + "\n");
  process.exit(1);
};

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Whether path is a symlink (lstat, not stat: a broken link is still a link the pack holds). */
const isSymlink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Whether a symlink, followed, stays inside the pack root. */
const resolvesInside = (root, link) => {
  const base = resolve(root);
  const resolved = resolve(dirname(link), readlinkSync(link));
  return resolved === base || resolved.startsWith(base.endsWith("/") ? base : base + "/");
};

/**
 * Every payload under root, recursively, as pack-relative posix paths, sorted.
 *
 * A symlink is payload too. The pack's store/ tree is nothing but symlinks into lib/store/, and a
 * manifest that skipped them would leave their targets unaccounted for: re-pointing one at
 * /etc/passwd would still verify. So each is listed with the target it actually has.
 */
const payload = (root) => {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      // The mode comes from lstat: on a filesystem that does not report d_type for entries a
      // Dirent may answer neither isDirectory nor isSymbolicLink, and the entry would vanish.
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink()) out.push({ path: relative(root, path).split("\\").join("/"), symlink: true, target: readlinkSync(path) });
      else if (entry.isFile()) out.push({ path: relative(root, path).split("\\").join("/"), symlink: false });
    }
  };
  visit(root);
  return out;
};

/** Just the paths, for the manifest writer. */
const walk = (root) => payload(root).map((entry) => entry.path);
/** ldd's view of a file's dependencies: the store paths the loader resolves. */
const dependencies = (path) => {
  const result = spawnSync("ldd", [path], { encoding: "utf8" });
  const paths = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    const match = /\/nix\/store\/[^\s]+/.exec(line);
    if (match !== null) paths.push(match[0]);
  }
  return paths;
};

/** The first /nix/store entry named file, at its usual lib/ location; undefined when absent. */
const storeFile = (file) => {
  const result = spawnSync("sh", ["-c", "compgen -G '/nix/store/*/*/" + file + "' | head -n 1"], { encoding: "utf8" });
  const found = (result.stdout ?? "").trim();
  return found === "" ? undefined : found;
};

/** Every library reachable from seeds, transitively, as absolute store paths. */
const closure = (seeds) => {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    for (const dependency of dependencies(path)) {
      if (!seen.has(dependency)) queue.push(dependency);
    }
  }
  return [...seen].sort();
};

/**
 * Libraries: stage every shared object the engine and the Vulkan stack load into one flat lib/,
 * record which Nix store path each came from, and (unless told not to) mirror the closure under
 * lib/store/<store name>/ plus a store/ tree of relative symlinks.
 *
 * Measured on this host (0235), because each line cost a day of bisecting:
 *
 * - The release ships no libxcb / libxkbcommon / libxkbcommon-x11 (spike S12). They are seeded by
 *   name from the Nix store, so a host without them fails here instead of producing a pack that
 *   cannot load (C2).
 * - PNG needs the software Vulkan driver (spike S12b), so lavapipe and the loader are staged too.
 * - A Nix-built library names its neighbours by absolute /nix/store path, which the loader follows
 *   before LD_LIBRARY_PATH. Putting a Nix host's own C runtime copy (glibc) on the search path of
 *   a binary that this host runs through nix-ld makes it die with "stack smashing detected":
 *   nix-ld's loader is 2.44, and the store closure also names 2.42-67. So lib/ carries every
 *   library *except* the C runtime, and lib/store/ keeps every copy where the store bind finds it.
 * - PNG additionally needs the driver to be loadable by the absolute path the ICD names. The ICD
 *   is copied unchanged (Mesa names /nix/store/.../libvulkan_lvp.so), and the pack ships those
 *   bytes at lib/store/<the same path>. Rewriting the ICD to the flat "libvulkan_lvp.so" leaves
 *   PDF working and PNG failing with "no HeadlessRenderer configured" (C4's failure, by accident).
 */
const libraries = () => {
  const engine = option("engine");
  const vulkanLoader = option("vulkan-loader");
  const mesa = option("mesa");
  const pack = option("pack");
  const report = option("report");
  const mirror = option("store-mirror") !== "1";

  const seeds = [engine, join(vulkanLoader, "lib", "libvulkan.so.1"), join(mesa, "lib", "libvulkan_lvp.so")];
  for (const name of SEED_LIBRARIES) {
    const found = storeFile(name);
    if (found === undefined) fail("the build host has no " + name + " in /nix/store (nixpkgs libxcb, libxkbcommon)");
    seeds.push(found);
  }

  const rows = [];
  const flat = new Set();
  for (const path of closure(seeds)) {
    if (!/\/(lib|lib64)\/[^/]+\.so(\.|$)/.test(path)) continue;
    const storePath = /^\/nix\/store\/([^/]+)\//.exec(path);
    if (storePath === null) continue;
    const storeName = storePath[1];
    const inStore = path.slice(("/nix/store/" + storeName + "/").length);
    const target = join(pack, "lib", "store", storeName, inStore);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
    chmodSync(target, 0o644);
    // The flat name is what LD_LIBRARY_PATH finds. First writer wins, and the C runtime never gets
    // one: see the note above.
    if (!flat.has(basename(path)) && !C_RUNTIME.has(basename(path))) {
      flat.add(basename(path));
      copyFileSync(path, join(pack, "lib", basename(path)));
      chmodSync(join(pack, "lib", basename(path)), 0o644);
    }
    if (mirror) {
      const linkDir = join(pack, "store", storeName, inStore.slice(0, inStore.lastIndexOf("/")));
      mkdirSync(linkDir, { recursive: true });
      const link = join(linkDir, basename(path));
      if (!existsSync(link)) {
        symlinkSync(relative(linkDir, join(pack, "lib", "store", storeName, inStore)), link);
      }
    }
    rows.push(path + "\t" + storeName + "/" + inStore + "\t" + basename(path));
  }
  if (rows.length === 0) fail("no libraries were staged");
  writeFileSync(report, rows.join("\n") + "\n");

  // The pieces the release does not ship and the spike found necessary. A pack that lost one of
  // them fails at load time naming it, which is what C2 and C4 show.
  for (const name of [...SEED_LIBRARIES, "libvulkan.so.1", "libvulkan_lvp.so"]) {
    if (!existsSync(join(pack, "lib", name))) fail("the closure is missing " + name);
  }
};

/**
 * The Vulkan driver manifest (ICD) the engine's wgpu stack reads.
 *
 * Mesa publishes it naming the absolute store path of its own driver, and wgpu needs exactly that:
 * rewriting the entry to the flat "libvulkan_lvp.so" leaves PDF working and makes PNG fail with
 * "no HeadlessRenderer configured" (measured in 0235). The pack keeps the path and records where
 * the bytes live inside it (manifest.json's build.environment.VK_ICD_SANDBOX), so a sandbox that
 * binds the pack's copy at the same store path gets the same image.
 */
const icd = () => {
  const mesa = option("mesa");
  const pack = option("pack");
  const source = join(mesa, "share", "vulkan", "icd.d", "lvp_icd.x86_64.json");
  if (!existsSync(source)) fail("mesa has no " + source);
  const value = JSON.parse(readFileSync(source, "utf8"));
  const library = value.ICD?.library_path;
  if (typeof library !== "string" || !library.startsWith("/nix/store/")) {
    fail(source + " does not name its driver by Nix store path; the pack cannot mirror it");
  }
  const target = join(pack, "share", "vulkan", "icd.d", "lvp_icd.x86_64.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
};

/**
 * fonts.conf. Relative dirs resolve against FONTCONFIG_PATH, which the machine sets to the pack
 * root (0236), so the pack renders the same at any mount point.
 *
 * No <include> of the host's fonts.conf: a host font filling in for a missing pack font is exactly
 * the "silently substitute" that C3 rules out. The engine still needs one base face — it resolves
 * .SystemUIFont through DejaVu Sans and refuses to start without any — which is why DejaVu Sans is
 * in the pack.
 */
const fontsConf = () => {
  const pack = option("pack");
  writeFileSync(
    join(pack, "fonts.conf"),
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      "<!-- Written by tools/office-pack/build.sh. A relative path resolves against FONTCONFIG_PATH,",
      "     which the machine sets to this directory. There is no host <include> on purpose. -->",
      "<fontconfig>",
      '  <dir prefix="relative">fonts</dir>',
      "  <!-- The cache lives in the pack: a check (pack.mjs fonts) must not write elsewhere. -->",
      '  <cachedir prefix="relative">var/cache/fontconfig</cachedir>',
      "</fontconfig>",
      "",
    ].join("\n"),
  );
};

/** The first of names that exists under dir, recursively; undefined when none does. */
const findFile = (dir, names) => {
  for (const path of walk(dir)) {
    if (names.includes(basename(path))) return join(dir, path);
  }
  return undefined;
};

/**
 * The four pieces AGPL-3.0 and D102 require of a distribution that conveys the binary: the licence
 * text, the notice, the corresponding source (section 7(b)), and the About wording that names the
 * program.
 */
const legal = () => {
  const pack = option("pack");
  const version = option("version");
  const repository = option("repository");
  const digest = option("appimage-sha256");
  const engineDir = option("engine-dir");

  const licence = findFile(engineDir, ["LICENSE", "LICENSE.txt", "COPYING", "LICENSE.md"]);
  if (licence === undefined) fail("the release carries no LICENSE file; the pack cannot convey it without one");
  copyFileSync(licence, join(pack, "LICENSE"));
  if (!readFileSync(join(pack, "LICENSE"), "utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
    fail(licence + " is not the AGPL text");
  }

  writeFileSync(
    join(pack, "NOTICE"),
    [
      "hns Office engine pack",
      "======================",
      "",
      "ibisOffice " + version + " — https://github.com/" + repository,
      "Copyright (C) the ibisOffice authors. Licensed under the GNU Affero General Public",
      "License, version 3 only (AGPL-3.0-only). The full text is LICENSE next to this file.",
      "",
      "This distribution conveys the unmodified ibisOffice " + version + " release binary",
      "(bin/ibisOffice, AppImage sha256 " + digest + "). hns runs it as a separate program: it",
      "does not link against ibisOffice, does not modify it, and shows no ibisOffice interface.",
      "",
      "The corresponding source, and how to fetch it byte for byte, is in SOURCE.md.",
      "",
      "Third parties bundled with it (licence texts in legal/, sources in SOURCE.md):",
      "",
      "  IPAexGothic      fonts/ipaexg.ttf              IPA Font License v1.0",
      "  Noto Sans JP     fonts/NotoSansJP-*.otf        SIL Open Font License 1.1",
      "  DejaVu Sans      fonts/DejaVuSans.ttf          Bitstream Vera and public-domain additions",
      "  Mesa (lavapipe)  lib/libvulkan_lvp.so + deps   MIT and other permissive licences",
      "  Vulkan Loader    lib/libvulkan.so.1            Apache-2.0",
      "  libxcb, libxkbcommon, libx11 and their dependencies (MIT, X11, BSD and other",
      "  permissive licences). manifest.json's build.inputs names the exact Nix store paths.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(pack, "SOURCE.md"),
    [
      "# Corresponding source (AGPL-3.0 section 7(b))",
      "",
      "The pack contains an **unmodified** ibisOffice " + version + " binary. Its corresponding",
      "source is the upstream tree at the release's tag; hns changes nothing in it.",
      "",
      "    git clone https://github.com/" + repository,
      "    cd ibis-office",
      "    git checkout v" + version,
      "    git submodule update --init --recursive   # nine forks, required by [patch.crates-io]",
      "",
      "Or take the release archive and compare its digest yourself:",
      "",
      "    curl -fsSLO https://github.com/" + repository + "/archive/refs/tags/v" + version + ".tar.gz",
      "    sha256sum v" + version + ".tar.gz",
      "",
      "The conveyed binary is the AppImage asset",
      "",
      "    https://github.com/" + repository + "/releases/download/v" + version + "/ibisOffice-" + version + "-Linux.AppImage",
      "",
      "whose sha256 is " + digest + " (51,472,144 bytes). tools/office-pack/build.sh refuses",
      "any file whose digest differs, so a pack that names this file was built from that asset.",
      "",
      "The AppImage's own build recipe (its squashfs image and runtime) is upstream's release",
      "workflow in the same repository; this pack does not alter it beyond unpacking, and does not",
      "add to, remove from, or patch the binary.",
      "",
      "The fonts and libraries are third-party works under their own licences (legal/, NOTICE).",
      "Their sources are the pinned URLs and Nix store paths in tools/office-pack/build.sh; the",
      "store paths in manifest.json's build.inputs identify the exact builds.",
      "",
      "If someone else conveyed this pack to you, AGPL section 6 lets you ask them for the source;",
      "this file says where theirs came from.",
      "",
    ].join("\n"),
  );

  // The About panel's wording: what a person reads when they open Help > About, and the text D102
  // asks the distribution to carry. A file, so it is reviewed like the rest.
  writeFileSync(
    join(pack, "About.txt"),
    [
      "hns Office engine",
      "",
      "Rendering by ibisOffice " + version + " — https://github.com/" + repository,
      "Licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only).",
      "This program is free software: you can redistribute it and/or modify it under the terms of",
      "the AGPL-3.0. There is NO WARRANTY, to the extent permitted by law.",
      "",
      "ibisOffice is used unmodified and runs as a separate program. The corresponding source, the",
      "licence text and the third-party notices ship with this pack: SOURCE.md, LICENSE, NOTICE.",
      "The engine's own Help > About panel shows the same program name and version.",
      "",
    ].join("\n"),
  );
};

/** Where a /nix/store driver's copy lives in the pack (lib/store/<store name>/...); undefined otherwise. */
const relativeDriverPath = (driver) =>
  driver.startsWith("/nix/store/") ? "lib/store/" + driver.slice("/nix/store/".length) : undefined;

/** The paths a manifest accounts for (what verify checks); empty when it has none. */
const manifestFiles = (pack) => {
  try {
    return Object.keys(JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8")).files ?? {});
  } catch {
    return [];
  }
};

/** The absolute driver path the pack's ICD names (a /nix/store path). */
const icdLibraryPath = (pack) => {
  const value = JSON.parse(readFileSync(join(pack, "share", "vulkan", "icd.d", "lvp_icd.x86_64.json"), "utf8"));
  return value.ICD.library_path;
};

/**
 * The font check: which faces the pack's fonts.conf actually resolves, read from fontconfig
 * (fc-list) rather than from the pack's own file list.
 *
 * The engine does not report a font it could not find: with IPAexGothic gone it draws Japanese in
 * whatever fontconfig offers next and says nothing. So this is the check a caller can trust — it
 * lists the faces fontconfig resolves *from the pack's own files* and names the pack files that
 * resolved to none. Matching on the file as well as the family is what makes a fonts.conf that
 * fell back to a host font (a <include>, say) fail instead of passing as "found". (C3.)
 *
 * It writes nothing: the pack's var/cache/fontconfig is the cache, so a check does not create
 * directories in a caller's working directory.
 */
const fonts = () => {
  const pack = option("pack");
  const fcList = option("fontconfig") ?? "fc-list";
  const expected = {
    "fonts/ipaexg.ttf": "IPAexGothic",
    "fonts/NotoSansJP-Regular.otf": "Noto Sans JP",
    "fonts/NotoSansJP-Bold.otf": "Noto Sans JP",
    "fonts/DejaVuSans.ttf": "DejaVu Sans",
  };
  const result = spawnSync(fcList, [], {
    encoding: "utf8",
    cwd: tempdir("fonts"),
    env: { HOME: tempdir("fonts"), PATH: process.env.PATH ?? "", FONTCONFIG_FILE: join(pack, "fonts.conf"), FONTCONFIG_PATH: pack },
  });
  if (result.status !== 0) {
    fail("fc-list failed under the pack's fonts.conf: " + (result.stderr ?? result.error?.message ?? "").trim());
  }
  const found = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    const match = /^([^:]+): ([^:]+):/.exec(line);
    if (match === null) continue;
    found.push({ file: relative(pack, match[1]).split("\\").join("/"), family: match[2] });
  }
  const missing = Object.entries(expected)
    .filter(([path, family]) => !found.some((entry) => entry.file === path && entry.family.split(",").includes(family)))
    .map(([path]) => path);
  process.stdout.write(JSON.stringify({ found, missing }) + "\n");
  if (missing.length > 0) process.exit(2);
};

/**
 * The one scratch directory the checks run in, made on first use.
 *
 * Fixed rather than numbered per run (0235 NB2): a directory per invocation left one behind every
 * time, and nothing outside it is ever written. Its content is a fontconfig cache and nothing a
 * later run depends on.
 */
const tempdir = (name) => {
  const path = join(tmpdir(), "hns-office-pack-" + name);
  mkdirSync(path, { recursive: true });
  return path;
};

/**
 * Why this pack cannot render, as phrases that name the path; empty when it can.
 *
 * Every path comes from the manifest — `runtime.bindPaths` and the ICD it names — and is checked,
 * never discovered: a driver that exists only because this host has the store path is not
 * reachable, and a bind whose digest does not match the file is refused rather than trusted.
 */
const reachable = (pack, value) => {
  const reasons = [];
  const bound = new Set();
  for (const entry of value.build?.runtime?.bindPaths ?? []) {
    if (typeof entry.path !== "string" || !entry.path.startsWith("/")) {
      reasons.push("bindPaths names a relative path: " + String(entry.path));
      continue;
    }
    // The digest is a claim the manifest always makes, whether or not this host can check it yet:
    // an entry that names no well-formed sha256 is not a bind the machine may set up.
    if (typeof entry.sha256 !== "string" || !OFFICE_DIGEST.test(entry.sha256)) {
      reasons.push(entry.kind + " at " + entry.path + " has no sha256 in the manifest");
      continue;
    }
    // When the file is here it has to be the file named: a wrong digest means the pack would run
    // something else under a path it wrote down, which is worse than a missing file.
    if (existsSync(entry.path)) {
      if (!statSync(entry.path).isFile()) {
        reasons.push(entry.kind + " at " + entry.path + " is not a regular file");
        continue;
      }
      if (entry.sha256 !== "sha256:" + sha256(entry.path)) {
        reasons.push(entry.kind + " at " + entry.path + " is not the file the manifest names");
        continue;
      }
    }
    // Verified here, or declared for the machine to bind: either way it is a path this pack means.
    bound.add(entry.path);
  }

  const icdPath = value.build?.environment?.VK_ICD_FILENAMES;
  if (typeof icdPath !== "string") return [...reasons, "build.environment.VK_ICD_FILENAMES is missing"];
  const icd = join(pack, icdPath);
  if (!existsSync(icd)) return [...reasons, "Vulkan driver manifest not found at " + icd];
  const driver = String(JSON.parse(readFileSync(icd, "utf8")).ICD?.library_path);

  // The pack's own copy, checked by digest rather than by existence: a driver file deleted from the
  // pack is not found here even though this host still has the store path the ICD names.
  const relative = relativeDriverPath(driver);
  const copy = relative === undefined ? undefined : value.files?.[relative];
  const copied =
    typeof copy === "string" &&
    OFFICE_DIGEST.test(copy) &&
    existsSync(join(pack, relative)) &&
    copy === "sha256:" + sha256(join(pack, relative));

  if (!copied && !bound.has(driver)) reasons.push("Vulkan driver not found at " + driver);
  return reasons;
};
/**
 * The manifest of docs/office.md section 11: what the pack can do, under which licence, and every
 * file it conveys with its digest.
 *
 * capabilities.operations lists only what the v0.8.7 release binary can produce. preview, render
 * and convert are the CLI's PDF and PNG exports; inspect / edit / recalculate belong to the
 * sidecar (0242) and are declared when it exists. Listing an operation the pack cannot do would
 * turn "unsupported_command" into "ran and failed", which is the wrong answer to a person.
 */
const manifest = () => {
  const pack = option("pack");
  const version = option("version");
  const report = option("report");
  const mesa = option("mesa");
  const vulkanLoader = option("vulkan-loader");

  // `files` is byte payload only, because that is what the contract says it is: relative path ->
  // "sha256:<hex>" (EngineManifestSchema). A symlink holds no bytes, so it does not belong there —
  // listing one would make the machine reject a legitimate pack the moment it validates the
  // manifest (0235 review). The links live in build.symlinks, which the schema does not know, the
  // same place runtime.bindPaths puts what the contract has no shape for.
  const files = {};
  const symlinks = [];
  for (const entry of payload(pack)) {
    // The manifest is what carries the list; About.txt is read by a person, not loaded.
    if (entry.path === "manifest.json" || entry.path === "About.txt") continue;
    if (entry.symlink === true) {
      symlinks.push({ path: entry.path, target: entry.target, sha256: "sha256:" + sha256(join(pack, entry.path)) });
    } else {
      files[entry.path] = "sha256:" + sha256(join(pack, entry.path));
    }
  }
  const libraries = readFileSync(report, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [path, name] = line.split("\t");
      return { path, name };
    });

  const value = {
    id: "ibisoffice",
    version,
    capabilities: { formats: FORMATS, operations: OPERATIONS },
    license: { spdx: SPDX, notice: "NOTICE", source: "SOURCE.md" },
    files,
    build: {
      // Not part of EngineManifestSchema, which 0236 validates the fields above against. A person
      // answering "what is in this pack, and from where" reads this, and so does the sandbox's
      // bind list: runtime.bindPaths is what has to appear outside the pack before render works.
      platform: "linux-x86_64",
      operations: {
        preview: "bin/ibisOffice --export pdf",
        render: "bin/ibisOffice --export png",
        convert: "bin/ibisOffice --export pdf",
      },
      environment: {
        LD_LIBRARY_PATH: "lib",
        FONTCONFIG_FILE: "fonts.conf",
        FONTCONFIG_PATH: "<pack root>",
        VK_ICD_FILENAMES: "share/vulkan/icd.d/lvp_icd.x86_64.json",
        VK_DRIVER_FILES: "share/vulkan/icd.d/lvp_icd.x86_64.json",
      },
      // Every symlink the pack holds, with the target it has and the digest behind it. Not in
      // `files` (see above). verify.sh reads both lists.
      symlinks,
      runtime: {
        // The parts of the pack that are NOT in the pack, named by absolute path and digest instead of
        // searched for at run time (0236 ro-binds each one; 0194 already binds stores that way).
        //
        // Today one entry: the Mesa lavapipe driver, which the ICD names by its absolute store path
        // (see icd()). The pack carries the same bytes under lib/store/, so preview and render work
        // without the bind; the entry is what says so out loud, so the machine binds a known path
        // rather than trusting that the host still has one at a path nobody wrote down.
        bindPaths: [{
          kind: "icd",
          path: icdLibraryPath(pack),
          sha256: "sha256:" + sha256(join(pack, "lib", "store", icdLibraryPath(pack).slice("/nix/store/".length))),
        }],
      },
      fonts: ["fonts/ipaexg.ttf", "fonts/NotoSansJP-Regular.otf", "fonts/NotoSansJP-Bold.otf", "fonts/DejaVuSans.ttf"],
      inputs: { mesa, vulkanLoader },
      libraries,
    },
  };
  writeFileSync(join(pack, "manifest.json"), JSON.stringify(value, null, 2) + "\n");
};
/**
 * The render preflight: is the Vulkan driver reachable from exactly the paths the manifest names?
 *
 * `render` needs a working Vulkan stack; `preview` and `convert` do not (C4). The machine asks
 * this before it answers officeEngine, and answers `{ available: false, reason }` naming the path
 * that is missing rather than running PNG and failing (or calling render unsupported).
 */
const render = () => {
  const pack = option("pack");
  const manifestPath = join(pack, "manifest.json");
  if (!existsSync(manifestPath)) fail("no manifest.json in " + pack);
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  const reasons = reachable(pack, value);
  process.stdout.write(JSON.stringify(reasons.length === 0 ? { available: true } : { available: false, reason: reasons.join("; ") }) + "\n");
  if (reasons.length > 0) process.exit(2);
};

/**
 * Checks a pack against its own manifest, and the parts D102 requires it to convey.
 *
 * Every entry is checked as what it claims to be: a file at its digest, or a symlink whose target
 * is the recorded one and resolves inside the pack — the store/ tree is nothing but links, and a
 * link re-pointed at /etc/passwd is a file the distribution did not account for. Files the
 * manifest does not name are faults too (a file nobody recorded is a file nobody can account
 * for). The licence pieces are checked separately: their absence breaks conveying, not rendering.
 */
const verify = () => {
  const pack = option("pack");
  const manifestPath = join(pack, "manifest.json");
  if (!existsSync(manifestPath)) fail("no manifest.json in " + pack);
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];

  for (const [field, path] of [
    ["license.notice", value.license?.notice],
    ["license.source", value.license?.source],
  ]) {
    if (typeof path !== "string" || !existsSync(join(pack, path))) problems.push(field + " is missing (" + String(path) + ")");
  }
  for (const required of ["LICENSE", "NOTICE", "SOURCE.md", "About.txt"]) {
    if (!existsSync(join(pack, required))) problems.push(required + " is missing");
  }
  if (existsSync(join(pack, "LICENSE"))) {
    if (!readFileSync(join(pack, "LICENSE"), "utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
      problems.push("LICENSE is not the AGPL text");
    }
  }
  if (typeof value.license?.spdx === "string" && value.license.spdx !== SPDX) {
    problems.push("license.spdx is " + value.license.spdx + ", expected " + SPDX);
  }

  // `files` says which bytes the pack holds: each entry is a file at its digest. `build.symlinks`
  // says which links it holds: each points where it claims, stays inside the pack, and leads to the
  // bytes recorded. A link holds no bytes, so it is not in `files` (see manifest()).
  const files = value.files ?? {};
  for (const [path, digest] of Object.entries(files)) {
    const target = join(pack, path);
    if (!existsSync(target)) {
      problems.push(path + " is in the manifest but not in the pack");
      continue;
    }
    if (isSymlink(target)) {
      problems.push(path + " is listed as a file but is a symlink");
      continue;
    }
    const actual = "sha256:" + sha256(target);
    if (typeof digest !== "string" || !OFFICE_DIGEST.test(digest)) problems.push(path + " has no sha256 in the manifest");
    else if (actual !== digest) problems.push(path + " is " + actual + ", the manifest says " + digest);
  }
  for (const link of value.build?.symlinks ?? []) {
    const path = typeof link.path === "string" ? link.path : "";
    const target = join(pack, path);
    if (path === "" || !isSymlink(target)) {
      problems.push(path + " is listed as a symlink but is not one");
      continue;
    }
    const actual = readlinkSync(target);
    if (!existsSync(target)) problems.push(path + " points at nothing (" + actual + ")");
    else if (actual !== link.target) problems.push(path + " points at " + actual + ", the manifest says " + String(link.target));
    else if (!resolvesInside(pack, target)) problems.push(path + " points outside the pack (" + actual + ")");
    // The target's digest is what the link means: a link that still points inside the pack but at
    // rewritten bytes is a different file, and the machine would copy those to /nix/store.
    else if (typeof link.sha256 !== "string" || !OFFICE_DIGEST.test(link.sha256)) problems.push(path + " has no sha256 in the manifest");
    else if ("sha256:" + sha256(target) !== link.sha256) problems.push(path + " resolves to " + ("sha256:" + sha256(target)) + ", the manifest says " + link.sha256);
  }
  // Every payload the pack holds is accounted for in one list or the other; anything else is a file
  // the distribution carries without the manifest saying so.
  const links = new Set((value.build?.symlinks ?? []).map((link) => link.path));
  for (const path of walk(pack)) {
    if (path === "manifest.json" || path === "About.txt") continue;
    if (!(path in files) && !links.has(path)) problems.push(path + " is in the pack but not in the manifest");
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write("office-pack: " + problem + "\n");
    process.exit(1);
  }
  process.stdout.write("office-pack: " + pack + " verifies (" + Object.keys(files).length + " files, ibisOffice " + value.version + ")\n");
};
const sandbox = () => {
  const pack = option("pack");
  const operation = option("operation") ?? "pdf";
  // The input is the document to render, not a pack file: it stays where the caller put it.
  const input = String(option("input"));
  const manifest = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
  const bound = manifest.build?.runtime?.bindPaths ?? [];
  // render (PNG) needs the driver; preview and convert (PDF) do not.

  // A throw-away view of what the sandbox can see: the pack, the declared paths, and nothing else
  // of this host's /nix/store. (0236 builds the same view with ro binds.)
  const view = join(tmpdir(), "hns-office-pack-sandbox-" + process.pid);
  rmSync(view, { recursive: true, force: true });
  mkdirSync(join(view, "nix/store"), { recursive: true });
  cpSync(pack, join(view, "pack"), { recursive: true });
  for (const entry of bound) {
    if (!existsSync(entry.path)) continue; // stood up from the pack below
    const target = join(view, String(entry.path));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(entry.path, target);
  }
  // The question is asked in the view: a driver the pack carries is a driver; a store path nobody
  // bound is not. A view that was meant to have the driver and cannot find it is the pack saying
  // "render is not available here", before the engine runs and with the path named — the engine
  // would otherwise read the host's stores, which is the "works on my machine" 0235 rules out.
  // Ask in the view, about the files the view has: whether a sandbox can render does not depend on
  // what this host keeps in /nix/store. A view without the driver answers "render is not available",
  // naming the path, before the engine runs — instead of the engine finding a driver in the host
  // that the machine will not have.
  const viewPack = join(view, "pack");
  const viewFiles = {};
  for (const path of Object.keys(manifest.files ?? {})) {
    if (existsSync(join(viewPack, path))) viewFiles[path] = "sha256:" + sha256(join(viewPack, path));
  }
  const reasons = reachable(viewPack, { ...manifest, files: viewFiles });
  if (operation === "png" && reasons.length > 0) {
    rmSync(view, { recursive: true, force: true });
    process.stderr.write(reasons.join("; ") + "\n");
    process.exit(2);
  }
  const out = join(view, "out");
  mkdirSync(out, { recursive: true });
  const environment = manifest.build?.environment ?? {};
  const libraryPath = [join(view, "pack", String(environment.LD_LIBRARY_PATH))];
  for (const entry of bound) if (entry.kind === "ld-library") libraryPath.push(dirname(String(entry.path)));
  const icd = join(view, "pack", String(environment.VK_ICD_FILENAMES));
  const result = spawnSync(join(view, "pack", "bin/ibisOffice"), [
    "--export", String(operation), "--width", option("width") ?? "320", "--out-dir", out, input,
  ], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: view,
      LD_LIBRARY_PATH: libraryPath.join(":"),
      FONTCONFIG_FILE: join(view, "pack", String(environment.FONTCONFIG_FILE)),
      FONTCONFIG_PATH: join(view, "pack"),
      VK_ICD_FILENAMES: icd,
      VK_DRIVER_FILES: icd,
    },
  });
  process.stderr.write(result.stderr ?? "");
  if (result.status === 0) {
    mkdirSync(option("out"), { recursive: true });
    for (const name of readdirSync(out)) cpSync(join(out, name), join(option("out"), name));
  }
  rmSync(view, { recursive: true, force: true });
  process.exit(result.status ?? 1);
};
const commands = { libraries, icd, "fonts-conf": fontsConf, fonts, legal, manifest, render, sandbox, verify };
const run = commands[command];
if (run === undefined) fail("unknown command " + String(command) + ": " + Object.keys(commands).join(", "));
run();

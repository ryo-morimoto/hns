import { expect, test } from "vitest";
import { join } from "node:path";
import { ENGINE_ARGV_ORDER, engineArgv, killGroup } from "./engine.ts";
import type { EngineRun } from "./engine.ts";
import type { OfficePack } from "./pack.ts";

// The sandbox is an argument list, so the argument list is what the test reads: the mount order,
// the namespaces, the cleared environment, and the wrapper around the engine. None of it needs a
// host that can run bubblewrap, which is why it is unit-tested rather than proved only in the
// integration suite.

/** A pack as the engine sees it: a root, and the environment its manifest names. */
const pack: OfficePack = {
  root: "/packs/office",
  manifest: {
    id: "ibisoffice",
    version: "0.8.7",
    capabilities: { formats: ["docx"], operations: ["preview"] },
    license: { spdx: "AGPL-3.0-only", notice: "NOTICE", source: "SOURCE.md" },
    files: {},
  },
  build: {
    environment: {
      LD_LIBRARY_PATH: "lib",
      FONTCONFIG_FILE: "fonts.conf",
      FONTCONFIG_PATH: "<pack root>",
      VK_ICD_FILENAMES: "share/vulkan/icd.d/lvp_icd.x86_64.json",
    },
    runtime: { bindPaths: [] },
  },
};

/** One run: a preview of a document the caller staged. */
function run(overrides: Partial<EngineRun> = {}): EngineRun {
  return {
    pack,
    binds: [],
    input: "/work/run-1/input.docx",
    operation: "preview",
    work: "/work/run-1",
    workRoot: "/work",
    timeoutMs: 60_000,
    maxRssMb: 2048,
    maxOutputBytes: 100 * 1024 * 1024,
    maxPixels: 24_000_000,
    ...overrides,
  };
}

/** The argv the wrapper would be spawned with. */
function argv(overrides: Partial<EngineRun> = {}): readonly string[] {
  const spec = run(overrides);
  return engineArgv(spec, {
    binary: join(pack.root, "bin", "ibisOffice"),
    input: spec.input,
    output: join(spec.work, "out"),
    bwrap: "bwrap",
  });
}

/** The value following a flag, or undefined when the flag is not there. */
function after(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

// Catches: the network left on (an external link or an OLE object in a document would reach the
// internet), and a namespace or session left shared with the machine.
test("C9: the engine runs with no network and its own namespaces", () => {
  const args = argv();
  expect(args).toContain("--unshare-net");
  expect(args).toContain("--unshare-pid");
  expect(args).toContain("--unshare-ipc");
  expect(args).toContain("--unshare-uts");
  expect(args).toContain("--new-session");
  expect(args).toContain("--die-with-parent");
});

// Catches: an environment inherited from the server (a token, a GIT_DIR, the operator's HOME). The
// engine's environment is the wrapper's `--clearenv` and then exactly the values written after it.
test("C9: the engine environment is cleared and then set from the manifest", () => {
  const args = argv();
  expect(after(args, "--clearenv")).toBe("--setenv");
  const setenv: [string, string][] = [];
  for (let at = args.indexOf("--clearenv") + 1; at < args.length; at += 3) {
    if (args[at] !== "--setenv") break;
    setenv.push([args[at + 1] ?? "", args[at + 2] ?? ""]);
  }
  const names = setenv.map(([name]) => name);
  expect(names).toStrictEqual([
    "PATH",
    "HOME",
    "TMPDIR",
    "LD_LIBRARY_PATH",
    "FONTCONFIG_FILE",
    "FONTCONFIG_PATH",
    "VK_ICD_FILENAMES",
  ]);
  const values = Object.fromEntries(setenv);
  expect(values["HOME"]).toBe("/work/run-1");
  expect(values["LD_LIBRARY_PATH"]).toBe("/packs/office/lib");
  expect(values["FONTCONFIG_PATH"]).toBe("/packs/office");
  expect(values["PATH"]).toBe("/usr/bin:/bin");
  // Nothing of the caller's own environment is in the list.
  expect(names).not.toContain("HNS_OFFICE_PACK");
});

// Catches: the mount order reversed, so a later bind undoes a read-only one; the pack writable;
// and the runs' root hidden instead of the run (nothing beside the run is visible).
test("C9: the pack is read-only, the run is writable, and its neighbours are masked", () => {
  const args = argv();
  const packAt = args.indexOf(pack.root);
  expect(args[packAt - 1]).toBe("--ro-bind");
  const work = "/work/run-1";
  // `--dir` creates it inside the tmpfs and `--bind` then makes it writable; the pair is the run's.
  const workAt = args.indexOf(work);
  expect(args[workAt - 1]).toBe("--dir");
  const bindAt = args.indexOf(work, workAt + 1);
  expect(args[bindAt - 1]).toBe("--bind");
  // The fresh tmpfs is over the runs' root, and the run is bound into it.
  expect(after(args, "--tmpfs")).toBe("/work");
  expect(args.indexOf("--tmpfs")).toBeLessThan(args.indexOf("--bind"));
  // The whole host is read-only first, so what follows can only re-open a part of it.
  expect(args.slice(0, 7)).toStrictEqual([
    "bwrap",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/work",
  ]);
  expect(args.indexOf("--ro-bind")).toBeLessThan(args.indexOf("--bind"));
});

// Catches: a bind path from `build.runtime.bindPaths` mounted writable or not mounted at all. Each
// one is the file the manifest named, so the engine reads what the pack declared.
test("C9: every checked bind path is bound read-only at its own path", () => {
  const bind = {
    kind: "icd",
    path: "/nix/store/xxx-mesa/lib/libvulkan_lvp.so",
    sha256: "sha256:" + "a".repeat(64),
  } as const;
  const args = argv({ binds: [bind] });
  const at = args.indexOf(bind.path);
  expect(at).toBeGreaterThan(-1);
  expect(args[at - 1]).toBe("--ro-bind");
  // The pack's own ro bind comes first; the declared binds follow it, each at its absolute path.
  expect(args.indexOf(pack.root)).toBeLessThan(at);
});

// Catches: the engine run without a memory bound, or with the bound applied to the wrong process.
// The bound is the shell's `ulimit -v` immediately before `exec`, so the kernel holds the engine.
test("engine: the memory bound is set before the engine replaces the shell", () => {
  const args = argv({ maxRssMb: 512 });
  const shellAt = args.indexOf("/bin/sh");
  expect(args[shellAt + 1]).toBe("-c");
  const script = args[shellAt + 2] ?? "";
  expect(script).toContain("ulimit -v " + String(512 * 1024));
  expect(script).toContain('exec "$0" "$@"');
  expect(args[shellAt + 3]).toBe(join(pack.root, "bin", "ibisOffice"));
});

// Catches: a render asked for PDF (both operations share a binary, so the flag is what decides),
// and a width left out so the pack's default silently replaces the job's.
test("engine: the operation and the render width are the job's", () => {
  const preview = argv();
  expect(after(preview, "--export")).toBe("pdf");
  expect(preview).toContain("--out-dir");
  const render = argv({ operation: "render", width: 800 });
  expect(after(render, "--export")).toBe("png");
  expect(after(render, "--width")).toBe("800");
  const convert = argv({ operation: "convert" });
  expect(after(convert, "--export")).toBe("pdf");
  expect(convert).not.toContain("--width");
});

// Catches: a flag order the engine's parser reads differently. The order is stated once
// ({@link ENGINE_ARGV_ORDER}) and the test walks it, so a flag moved in the builder fails here.
test("engine: the argv follows the order the builder states", () => {
  const args = argv();
  let last = -1;
  for (const flag of ENGINE_ARGV_ORDER) {
    const at = args.indexOf(flag);
    if (at === -1) continue;
    expect(at, flag).toBeGreaterThan(last);
    last = at;
  }
});

// Catches: a kill that throws when the group is already gone (an engine that exited on its own),
// which would turn a normal answer into a 500.
test("engine: killing a process group that is gone is not an error", () => {
  expect(() => killGroup(undefined)).not.toThrow();
  expect(() => killGroup(2 ** 31 - 1)).not.toThrow();
});

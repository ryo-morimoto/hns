import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { zipOf } from "../support/zip.ts";
import { verifyArtifactTarget } from "../../src/office/artifact.ts";

// Mutation probes for the office executor: each one breaks a single property of the product
// and runs the assertion a reviewer relies on, so a test that passes against a broken machine
// cannot pass quietly. Each probe reads the product source, changes one expression, and imports
// the changed module through a data URL; its relative imports are rewritten to the real files so
// exactly one module is changed.

/** The machine package the probes mutate, from this file.
 *
 * @remarks
 * `new URL("../..")` from `test/security/` is the package root, which is where `src/office/` is.
 */
const packageRoot = fileURLToPath(new URL("../../src", import.meta.url));

/** The mutant files this run wrote; removed when the file is done. */
const pending: string[] = [];

afterAll(async () => {
  for (const path of pending) await rm(path, { force: true }).catch(() => undefined);
});

/**
 * Read one office module and rewrite it with a probe mutation.
 *
 * @param module - The module path, relative to the package root.
 * @param mutate - Turns the product text into the broken text.
 * @returns The path of the mutant module, which the probe imports.
 *
 * @throws {Error} When the mutation changed nothing: the expression a probe names is gone, which
 * is what makes the probe fail when the product it targets is refactored away.
 */
async function mutated(module: string, mutate: (text: string) => string): Promise<string> {
  const text = await readFile(join(packageRoot, "office", module), "utf8");
  // Every relative import of the product's source is pointed at its real file: the mutant lives in
  // a temporary directory, where a relative specifier would resolve against that directory.
  const rewritten = text.replace(
    /from "\.\.?\/([^"]+)\.ts"/gu,
    (_match: string, path: string) => 'from "' + join(packageRoot, path + ".ts") + '"',
  );
  const changed = mutate(rewritten);
  expect(changed, "the probe changed nothing").not.toBe(rewritten);
  // The mutant is written as a file, not handed over as a data URL: Vitest's transform is what
  // compiles the product's TypeScript, and it applies to a file. A data URL reaches the JavaScript
  // engine as it is, where the product's type syntax is a syntax error.
  const path = join(tmpdir(), "office-mutation-" + randomUUID() + ".ts");
  await writeFile(path, changed);
  pending.push(path);
  return path;
}
// M1 — take the prescan out. A workbook over the cell bound must then be accepted by the code that
// decides whether to run, and the integration suite's C1 is what catches it (the job runs and the
// answer is not "too many cells"): the probe proves the mutant removes the check by running both
// against the same document.
test("M1: with the cell bound removed, an over-large workbook is accepted", async () => {
  const url = await mutated("prescan.ts", (text) =>
    text.replace(
      "  if (counted.cells > limits.maxCells) {",
      "  if (counted.cells > Number.MAX_SAFE_INTEGER) {",
    ),
  );
  const product = await import("../../src/office/prescan.ts");
  // SAFETY: the mutant is the product's own module with one expression changed, so its exports are
  // the product's: the probe calls the one function whose signature it reads here.
  const mutant = (await import(/* @vite-ignore */ url)) as {
    scanOfficeInput(input: Parameters<typeof product.scanOfficeInput>[0]): {
      readonly ok: boolean;
    };
  };
  // A workbook whose one sheet declares 310,000 cells: over the 300,000 the contract ships.
  const bytes = zipOf(
    new Map([["xl/worksheets/sheet1.xml", '<worksheet><dimension ref="A1:AE10000"/></worksheet>']]),
  );
  const limits = {
    maxInputBytes: bytes.byteLength + 1,
    maxCells: 300_000,
    maxPixels: 24_000_000,
    timeoutMs: 60_000,
    maxOutputBytes: 100 * 1024 * 1024,
  };
  const input = { format: "xlsx" as const, limits, bytes, name: "huge.xlsx" };
  // The product refuses it; the mutant accepts it. Both are asserted, so the probe fails if the
  // product stops refusing (the property is gone) or if the mutation stops being one.
  expect(product.scanOfficeInput(input).ok).toBe(false);
  expect(mutant.scanOfficeInput(input).ok).toBe(true);
});

// M2 — stop looking in the cache. A second job of the same key must then run the engine instead of
// answering "cached: true", and the integration suite's C4 is what catches it. The probe proves the
// mutant lookup answers nothing for an entry the product just stored.
test("M2: a lookup that never hits leaves the cache useless", async () => {
  const url = await mutated("cache.ts", (text) =>
    text.replace(
      "    const metadata = await this.#readMetadata(metadataPath);",
      "    const metadata = undefined;",
    ),
  );
  const { OfficeCache } = await import("../../src/office/cache.ts");
  // SAFETY: the mutant is the product's own cache with one line changed; its class has the
  // product's constructor and methods.
  const mutantModule = (await import(/* @vite-ignore */ url)) as {
    OfficeCache: typeof OfficeCache;
  };
  const root = await mkdtemp(join(tmpdir(), "hns-office-mutation-"));
  try {
    const key = {
      workspaceId: "ws-1",
      pathHash: "0123456789abcdef",
      version: "sha256:" + "a".repeat(64),
      operation: "preview",
      paramsHash: "fedcba9876543210",
    } as const;
    const facts = {
      sha256: "sha256:" + "b".repeat(64),
      missingFonts: [],
      engine: { id: "ibisoffice", version: "0.8.7" },
    };
    const product = new OfficeCache({ root });
    await product.store(key, new Uint8Array([1]), facts);
    expect(await product.lookup(key)).toBeDefined();
    // The same entry, through the mutant: its store is the product's (unchanged) and its lookup
    // never finds what it stored, so every job would run the engine again.
    const mutant = new mutantModule.OfficeCache({ root });
    await mutant.store(key, new Uint8Array([1]), facts);
    expect(await mutant.lookup(key)).toBeUndefined();
    expect(await product.lookup(key)).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
// M3 — stop checking that the target is the one that was signed. docs §5 says the machine compares
// the request target it received with the canonical one byte for byte, and that comparison is what
// makes the signature mean what it says. The probe removes it and shows the same rewritten target
// the product refuses is then accepted.
test("M3: with the target comparison removed, another encoding of the same key is accepted", async () => {
  const url = await mutated("artifact.ts", (text) =>
    text.replace(
      "  if (target !== artifactTarget(parsed)) {",
      "  if (target === undefined as unknown as string) {",
    ),
  );
  const { artifactTarget, officeParamsHash } = await import("@hns/core/office");
  const { verifyArtifactTarget } = await import("../../src/office/artifact.ts");
  // SAFETY: the mutant is the product's own artifact module with one branch changed; the probe
  // only asks whether it throws, which is what both functions' signatures allow.
  const mutant = (await import(/* @vite-ignore */ url)) as {
    verifyArtifactTarget(target: string): ReturnType<typeof verifyArtifactTarget>;
  };
  const canonical = artifactTarget({
    workspaceId: "ws-1",
    path: "提案書.docx",
    version: "sha256:" + "a".repeat(64),
    operation: "preview",
    paramsHash: await officeParamsHash("preview", {}),
  });
  // The same key in the other encoding of the same characters: the names and the decoded values
  // are unchanged, so only the byte comparison can refuse it.
  const rewritten = canonical.replace("%E6%8F%90", "%e6%8f%90");
  expect(rewritten).not.toBe(canonical);
  expect(refusalOfProduct(rewritten)).toBe(true);
  expect(throwsOf(() => mutant.verifyArtifactTarget(rewritten))).toBe(false);
});

/** Whether the product refuses one target. */
function refusalOfProduct(target: string): boolean {
  try {
    verifyArtifactTarget(target);
    return false;
  } catch {
    return true;
  }
}

/** Whether calling one function throws. */
function throwsOf(call: () => void): boolean {
  try {
    call();
    return false;
  } catch {
    return true;
  }
}

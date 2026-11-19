import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * The build ships the document preview, and the preview ships its worker.
 *
 * @remarks
 * The panel is one screen of the shell; **if it is not reachable from the shell's imports, neither
 * its code nor the PDF.js worker it bundles is emitted** — and a preview that draws nothing looks
 * exactly like a panel that is closed (which is how a missing panel reached review once). So the
 * build is asserted here: `deploy/assets` (the Worker's static directory, D094) must hold a
 * `pdf.worker*.mjs` and a chunk that names it, and the page must load its bundle from the same
 * origin. The bundle is built by `vitest.config.ts` before this project runs, so the files are
 * this checkout's own build rather than a stale one.
 */
// Found from the repository root by walking up, not through `import.meta.url`: under Vite that is
// an `http:` URL, and the build lives on disk (the policy screen's tests find their schema so).
function checkoutRoot(): string {
  for (let dir = process.cwd(); ; dir = join(dir, "..")) {
    if (existsSync(join(dir, "deploy", "assets"))) return dir;
    if (join(dir, "..") === dir)
      throw new Error("deploy/assets is not above this working directory");
  }
}

const assets = join(checkoutRoot(), "deploy", "assets");

/** The three quote characters a bundle uses, for a pattern that has to name them. */
const QUOTES = String.fromCharCode(34, 39, 96);

/** Every built file, relative to `deploy/assets`. */
function built(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path.slice(assets.length + 1));
    }
  };
  walk(assets);
  return found;
}

test("the build holds a web bundle", () => {
  expect(existsSync(join(assets, "index.html"))).toBe(true);
  expect(built().filter((file) => file.endsWith(".js"))).not.toStrictEqual([]);
});

// Catches: the panel (and so PDF.js, and so its worker) unreachable from the shell's imports.
test("the PDF.js worker is emitted with the bundle", () => {
  const workers = built().filter((file) => /pdf\.worker.*\.mjs$/u.test(file));
  expect(workers).toHaveLength(1);
  const worker = join(assets, workers[0] ?? "");
  expect(statSync(worker).size).toBeGreaterThan(100_000);
});

// Catches: a worker the page cannot fetch — a URL that points at the package's `node_modules`
// path (what a test runner resolves `?url` to), at a CDN, or at an absolute path that does not
// exist in the deployment. The chunk names its worker as a same-origin, root-relative URL under
// `assets/`, and the emitted file is the one that URL names.
test("the bundle names the worker by a same-origin path that exists", () => {
  const code = built()
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(assets, file), "utf8"))
    .join("\n");
  // The worker's URL as the chunk spells it: a quoted path ending in `.mjs`.
  const pattern = new RegExp("(\\/?assets/pdf\\.worker[^" + QUOTES + "]*\\.mjs)", "gu");
  const names = [...code.matchAll(pattern)].map((match) => match[1]);
  expect(new Set(names).size).toBe(1);
  const url = names[0] ?? "";
  expect(url.startsWith("/assets/")).toBe(true);
  // `url` already carries `assets/`; relative to the bundle's directory is where Vite put it.
  expect(existsSync(join(assets, url.replace(/^\//u, "")))).toBe(true);
  // Nothing points the worker off-origin: neither the source `?url` import nor an absolute URL.
  expect(code.includes("pdf.worker.min.mjs?url")).toBe(false);
  expect(
    [...code.matchAll(/https?:\/\/[^"'\s`]+/gu)].filter((url) => url[0].includes("pdf.worker")),
  ).toStrictEqual([]);
});

// Catches: a page that loads some other script than the bundle this build made (an old index.html
// beside a new bundle, which is a worker URL nobody asked for).
test("the page loads the bundle this build made", () => {
  const html = readFileSync(join(assets, "index.html"), "utf8");
  const initial = /src="\/(assets\/[^"]+\.js)"/u.exec(html)?.[1] ?? "";
  expect(existsSync(join(assets, initial))).toBe(true);
  // The worker and the bundle were built together: the bundle's own URL is in the same listing.
  expect(built().some((file) => file === initial)).toBe(true);
});

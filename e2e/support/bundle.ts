import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * The app's built bundle, as `deploy/assets` holds it.
 *
 * @returns The asset directory and the entry script's URL.
 *
 * @remarks
 * **The bundle the journey serves is the one the build shipped**, not the dev server's:
 * `npm run build -w @hns/web` writes `deploy/assets` (D094), and that directory is what an edge
 * serves. The entry is read from the shipped `index.html` — the reference a browser follows — so
 * a bundle whose page does not name its entry is a failure here, before any document opens.
 */
export function builtBundle(): { readonly dir: string; readonly entry: string } {
  const dir = fileURLToPath(new URL("../../deploy/assets/", import.meta.url));
  const index = readFileSync(join(dir, "index.html"), "utf8");
  const entry = /<script[^>]+src="([^"]+)"/u.exec(index)?.[1];
  if (entry === undefined) throw new Error("deploy/assets/index.html names no entry script");
  return { dir, entry };
}

/**
 * A static asset binding over the build, and the page that runs it.
 *
 * @param dir - `deploy/assets`.
 * @returns The binding and the page's path.
 *
 * @remarks
 * The edge's `ASSETS` answers a path with a file of the build, as the deploys' does. The page is
 * a copy of the shipped `index.html` under this binding's path (`/app`), because the entry's
 * `src` is root-relative: the shell's own routes (`#/p/...`) belong to `index.html` itself, and a
 * copy at another path lets `page.goto` reach the app without a second build of the shell.
 * Everything else (`/assets/...`) is served as it is — the bundle, the lazy chunks and the PDF.js
 * worker `index.html`'s bundle names.
 */
export async function staticBuild(dir: string): Promise<{
  readonly fetch: (request: Request) => Promise<Response>;
  readonly pagePath: string;
}> {
  const index = await readFile(join(dir, "index.html"), "utf8");
  const pagePath = "/app";
  return {
    pagePath,
    fetch: async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      if (path === pagePath || path === pagePath + "/") {
        return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const file = join(dir, path);
      if (!file.startsWith(join(dir, "assets") + "/")) {
        return new Response("not found", { status: 404 });
      }
      try {
        const bytes = await readFile(file);
        return new Response(bytes, {
          headers: { "content-type": contentTypeOf(path) },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  };
}

/** A static file's media type, from its extension. */
function contentTypeOf(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/**
 * Write the journey's documents into a project's directory.
 *
 * @param root - The project's directory below the machine's ROOT.
 * @param files - Path to bytes; a nested path's directories are made as needed.
 * @returns Nothing.
 *
 * @remarks
 * The machine's ROOT is the workspace, so what it holds is what a file's version is computed
 * from: writing the bytes here is what makes the fixture a workspace document.
 */
export async function writeWorkspaceFiles(
  root: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const [path, bytes] of files) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}
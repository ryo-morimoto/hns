import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import type { Plugin } from "vite";

const MODULE = /\.[jt]sx?$/u;
// Absolute: babel resolves a relative artifact directory against the process cwd, which differs
// between the Vite build (packages/web) and vitest (the repo root).
const ARTIFACT_DIRECTORY = fileURLToPath(new URL("./src/__generated__", import.meta.url));

/**
 * Compile Relay's `graphql` tags with babel-plugin-relay.
 *
 * @returns A Vite plugin that runs before JSX/TS transforms.
 *
 * @remarks
 * The plugin runs on every module that mentions `graphql`; a module without a tag is returned
 * untouched. Vite builds the source map from the transformed code, so a stack still points at
 * the tagged file.
 */
export function relay(): Plugin {
  return {
    name: "hns-relay",
    enforce: "pre",
    // Babel imports `./__generated__/X.graphql`, whose file is `X.graphql.ts`; Vite treats a
    // specifier with a dot in the last segment as a complete path, so map it explicitly.
    resolveId(source, importer) {
      if (importer === undefined || !source.endsWith(".graphql")) return null;
      const candidate = resolve(dirname(importer), source + ".ts");
      return existsSync(candidate) ? candidate : null;
    },
    transform(code, id) {
      if (!MODULE.test(id) || !code.includes("graphql")) return null;
      const result = transformSync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [["relay", { artifactDirectory: ARTIFACT_DIRECTORY }]],
      });
      if (result?.code == null) return null;
      return { code: result.code };
    },
  };
}

import { transformSync } from "@babel/core";
import type { Plugin } from "vite";

const MODULE = /\.[jt]sx?$/u;

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
    transform(code, id) {
      if (!MODULE.test(id) || !code.includes("graphql")) return null;
      const result = transformSync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: ["relay"],
      });
      if (result?.code == null) return null;
      return { code: result.code };
    },
  };
}

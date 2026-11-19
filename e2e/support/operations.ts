import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./runtime.ts";

/**
 * The app's own GraphQL operation, as the app sends it.
 *
 * @param name - The generated artifact's name (`RequestMutation`, `DocumentPanelQuery`).
 * @returns Its `params` (the document's text, its name, its operation kind).
 *
 * @remarks
 * **Not a string written here.** The page's requests are the documents Relay compiled from the
 * app's `graphql` tags, and this reads that artifact: the journey sends the bytes the app sends,
 * so a document that changed shape is a journey that fails rather than one that kept working
 * against a copy nobody maintains. The artifact is generated (the gate's `codegen` stage), so it
 * is there whenever the app builds.
 */
export function operationOf(name: string): {
  readonly text: string;
  readonly name: string;
  readonly operationKind: string;
} {
  const file = join(

    REPO_ROOT,
    "packages/web/src/__generated__/" + name + ".graphql.ts",
  );
  const source = readFileSync(file, "utf8");
  // The artifact is a TypeScript module whose request object is a literal; the `params` member
  // it ends with is the one the network sends. Parsing the module's `params` from its source is
  // what keeps this a reader of the generated file rather than a second copy of the document.
  const at = source.indexOf('"params": {');
  if (at === -1) throw new Error("the artifact has no params: " + name);
  const start = source.indexOf("{", at + "\"params\": ".length);
  const end = matchingBrace(source, start);
  const params = JSON.parse(source.slice(start, end + 1)) as {
    text: string;
    name: string;
    operationKind: string;
  };
  return params;
}

/** The index of the `}` that closes the `{` at `open`, skipping strings. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let at = open; at < source.length; at += 1) {
    const char = source[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  throw new Error("the params object is not closed");
}
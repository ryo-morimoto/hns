/** The gate's codegen stage: read the generated files and refuse a hand-edited or stale one. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGenerated, type GeneratedFile } from "./check.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GENERATED = join(ROOT, "packages", "web", "src", "__generated__");
const SCHEMA = join(ROOT, "packages", "web", "schema.graphql");

const read = (path: string): string => readFileSync(path, "utf8");

const files: GeneratedFile[] = readdirSync(GENERATED)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ path: join(GENERATED, name), text: read(join(GENERATED, name)) }));
files.push({ path: SCHEMA, text: read(SCHEMA) });

const problems = checkGenerated(files);
if (problems.length > 0) {
  for (const problem of problems) console.error("codegen: " + problem);
  process.exit(1);
}

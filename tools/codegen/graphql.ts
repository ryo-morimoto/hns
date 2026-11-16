/**
 * Write the GraphQL schema the web package compiles its documents against.
 *
 * @remarks
 * The schema is the server's own (model types plus the Query root), printed to SDL. Run with
 * `npm run codegen`; the output is committed so relay-compiler needs no server process.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchemaSdl } from "@hns/server/graphql";

const target = fileURLToPath(new URL("../../packages/web/schema.graphql", import.meta.url));
writeFileSync(target, buildSchemaSdl(), "utf8");
console.log("wrote " + target);

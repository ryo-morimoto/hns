import type { GraphQLSchema } from "graphql";
import { buildSchema, execute, parse } from "graphql";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { OFFICE_PREVIEW_PATH, parsePreviewQuery } from "@hns/core/office";
import type { JsonValue } from "@hns/core";
import type { GraphQLCall } from "./relay.ts";
import type { PreviewRow } from "./officeWire.ts";

/**
 * The office face, over the published schema.
 *
 * @remarks
 * The real tests answer the panel's requests the way the server would: the request's text is
 * parsed and executed against `packages/web/schema.graphql`, and the executor's `data` is the
 * answer. The SDL declares the fields and has no resolvers, so the three office root fields are
 * given one here; everything else — the envelope, the enum's spelling, the union member, and
 * which fields a member carries — is the schema's own answer. A request the face could not
 * execute is an error, which the panel would draw as a broken read, and which a test must see
 * rather than a plausible substitute for it.
 */
export function publishedSchema(): GraphQLSchema {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "packages", "web", "schema.graphql");
    if (existsSync(candidate)) return buildSchema(readFileSync(candidate, "utf8"));
    const parent = dirname(dir);
    if (parent === dir) throw new Error("packages/web/schema.graphql is not in this checkout");
    dir = parent;
  }
}

/** A preview row as the resolver would answer it. */
type Row = Extract<PreviewRow, { readonly __typename: "DocumentPreview" }>;

/** The GraphQL view of a row: the enum spelling the contract publishes, and its nulls. */
function viewOf(row: Row, path: string) {
  return {
    __typename: "DocumentPreview",
    path,
    version: row.version,
    status: row.status,
    url: row.url,
    pages: row.pages,
    bytes: row.bytes,
    missingFonts: [],
    engine: row.status === "READY" ? "0.8.7" : null,
    generatedAt: "2026-11-19T00:00:00.000Z",
    error: row.error,
  };
}

/** What `officeEngine` answers in these tests. */
export type EngineAnswer =
  | { readonly __typename: "OfficeEngineAvailable"; readonly id: string; readonly version: string }
  | { readonly __typename: "OfficeEngineUnavailable"; readonly reason: string };

/**
 * Execute one request over the published schema, with the office fields resolved from one row.
 *
 * @param call - The call the panel made: its text, its variables.
 * @param row - The preview the office port answers with.
 * @param engine - What `officeEngine` answers.
 * @returns The `data` the executor produced.
 *
 * @throws When the request does not execute against the schema. That is a test's mistake (the
 * panel sent an operation the face does not have) and a made-up answer would hide it.
 */
export async function answerWith(
  call: GraphQLCall,
  row: PreviewRow,
  engine: EngineAnswer = { __typename: "OfficeEngineUnavailable", reason: "no pack" },
): Promise<Readonly<Record<string, JsonValue>>> {
  const path = v.safeParse(v.string(), call.variables["path"]);
  if (!path.success) throw new Error("a preview call names no path");
  const value = row.__typename === "DocumentPreview" ? viewOf(row, path.output) : row;
  const schema = publishedSchema();
  const fields = schema.getQueryType()?.getFields() ?? {};
  const documentPreview = fields["documentPreview"];
  const officeEngine = fields["officeEngine"];
  if (documentPreview === undefined || officeEngine === undefined) {
    throw new Error("the schema has no office fields");
  }
  documentPreview.resolve = () => value;
  officeEngine.resolve = () => engine;
  const mutation = schema.getMutationType()?.getFields()["requestDocumentPreview"];
  if (mutation === undefined) throw new Error("the schema has no requestDocumentPreview");
  mutation.resolve = () => value;
  const answer = await execute({
    schema,
    document: parse(call.query),
    variableValues: call.variables,
  });
  const errors = answer.errors ?? [];
  if (errors.length > 0) throw new Error(errors.map((error) => error.message).join(" | "));
  const data = answer.data;
  if (data === null || data === undefined) throw new Error("the schema answered no data");
  // SAFETY: graphql-js serialises `data` to JSON at the edge; every leaf of this schema is a
  // scalar or an enum, so the value is JSON data by construction.
  return data as Readonly<Record<string, JsonValue>>;
}

/**
 * The preview route a ready row names, read back the way the object reads it.
 *
 * @param workspaceId - The workspace's own id (not the `Project` global id).
 * @param path - The file's workspace-relative path.
 * @param version - The file's version.
 * @returns The URL a row hands out.
 *
 * @remarks
 * Built with the contract's own constant and checked with `parsePreviewQuery` before a test uses
 * it: a URL the object would refuse would prove nothing about the viewer.
 */
export function previewUrlOf(workspaceId: string, path: string, version: string): string {
  const query = new URLSearchParams({ workspaceId, path, v: version }).toString();
  const url = OFFICE_PREVIEW_PATH + "?" + query;
  const parsed = parsePreviewQuery(Array.from(new URLSearchParams(query).entries()));
  if (parsed.path !== path || parsed.version !== version) {
    throw new Error("the preview URL does not name the file");
  }
  return url;
}

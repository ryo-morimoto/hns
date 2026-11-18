import { expect, test } from "vitest";
import type { JsonValue } from "@hns/core";
import { createEdge } from "../edge/handler.ts";
import { createGraphQLFace } from "./handler.ts";
import type { OfficePort } from "./office.ts";
import type { DocumentPreviewView, OfficeEngineView, OfficeFailureView } from "../do/office-job.ts";
import { officeFailureOf } from "../do/office-job.ts";
import { envWith, sessionCookie } from "../../test/support/edge.ts";
/** The query a screen runs to read a preview. */
const PREVIEW = `query Preview($path: String!, $workspaceId: String) {
  documentPreview(path: $path, workspaceId: $workspaceId) {
    __typename
    ... on DocumentPreview { path version status url pages bytes engine missingFonts generatedAt error { code message } }
    ... on OfficeFailure { code message }
  }
}`;

/** The mutation a screen runs to ask for one. */
const REQUEST = `mutation Request($path: String!, $workspaceId: String) {
  requestDocumentPreview(path: $path, workspaceId: $workspaceId) {
    __typename
    ... on DocumentPreview { status url }
    ... on OfficeFailure { code }
  }
}`;

/** A ready row for the test file. */
const READY: DocumentPreviewView = {
  __typename: "DocumentPreview",
  path: "提案書.docx",
  version: "sha256:" + "a".repeat(64),
  status: "ready",
  url: "/api/office/preview?workspaceId=project-1&path=x&v=y",
  pages: 3,
  bytes: 1_024,
  missingFonts: [],
  engine: "0.8.7",
  generatedAt: "2026-11-19T00:00:00.000Z",
  error: null,
};

/** What a test's port answers: a row or a failure, per call. */
interface Answers {
  readonly preview?: (workspaceId: string, path: string) => PreviewAnswer | undefined;
  readonly request?: (workspaceId: string, path: string) => PreviewAnswer | undefined;
  readonly engine?: () => EngineAnswer;
}

/** One preview answer: the row, or the failure union's member. */
type PreviewAnswer = DocumentPreviewView | OfficeFailureView;

/** One engine answer. */
type EngineAnswer = OfficeEngineView | OfficeFailureView;

/** A port that answers what a test sets, and records what it was asked. */
function port(answers: Answers) {
  const asked: string[] = [];
  /** The version every call reads: the file's content hash. */
  const version = "sha256:" + "a".repeat(64);
  const office: OfficePort = {
    async preview(workspaceId, path) {
      asked.push("preview");
      return answers.preview?.(workspaceId, path);
    },
    async request(workspaceId, path) {
      asked.push("request");
      return answers.request?.(workspaceId, path) ?? officeFailureOf("engine_unavailable", "none");
    },
    async engine() {
      asked.push("engine");
      return answers.engine?.() ?? { __typename: "OfficeEngineUnavailable", reason: "none" };
    },
    async workspaceVersion() {
      asked.push("version");
      return { ok: true, version };
    },
  };
  return { office, asked };
}

/** Run one request through the real face and the real edge. */
async function send(
  body: { readonly query: string; readonly variables?: Readonly<Record<string, JsonValue>> },
  office: OfficePort,
) {
  const edge = createEdge({
    graphql: createGraphQLFace({ office }),
    ws: () => Promise.resolve(new Response("ok")),
  });
  const cookie = await sessionCookie("owner");
  const response = await edge(
    new Request("https://hns.test/graphql", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie },
    }),
    envWith(),
  );
  return { status: response.status, body: await response.json() };
}

// Catches: a preview served from a port that was never asked the workspace, or a union whose
// members a client cannot tell apart (0237 §6).
test("documentPreview answers the row, and requestDocumentPreview answers the request", async () => {
  const { office, asked } = port({
    preview: () => READY,
    request: () => ({ ...READY, status: "queued", url: null, pages: null, bytes: null }),
  });
  const read = await send(
    {
      query: PREVIEW,
      variables: { path: "提案書.docx", workspaceId: "project-1" },
    },
    office,
  );

  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({
    data: { documentPreview: { __typename: "DocumentPreview", status: "READY", pages: 3 } },
  });
  const written = await send(
    {
      query: REQUEST,
      variables: { path: "提案書.docx", workspaceId: "project-1" },
    },
    office,
  );
  expect(written.body).toMatchObject({
    data: {
      requestDocumentPreview: { __typename: "DocumentPreview", status: "QUEUED", url: null },
    },
  });
  // The read asked for the version first: a job names the bytes it reads (INV-O2).
  expect(asked).toContain("version");
});

// Catches: a failure answered as an eighth PreviewStatus, or a workspace the caller did not name
// being guessed: the failure union carries not_authorized (0237 C1).
test("a failure is the failure union, and no workspace is not_authorized", async () => {
  const { office } = port({
    preview: () => officeFailureOf("not_authorized", "outside"),
  });
  const outside = await send(
    {
      query: PREVIEW,
      variables: { path: "../other/a.docx", workspaceId: "project-1" },
    },
    office,
  );
  expect(outside.body).toMatchObject({
    data: { documentPreview: { __typename: "OfficeFailure", code: "NOT_AUTHORIZED" } },
  });
  const unknown = await send({ query: PREVIEW, variables: { path: "a.docx" } }, office);
  expect(unknown.body).toMatchObject({
    data: { documentPreview: { __typename: "OfficeFailure", code: "NOT_AUTHORIZED" } },
  });
});

// Catches: officeEngine answering a success for a machine that has no pack, or the engine probe
// being folded into the preview unions.
test("officeEngine says which side of the union the machine is on", async () => {
  const withPack = port({
    engine: () => ({ __typename: "OfficeEngineAvailable", id: "ibisoffice", version: "0.8.7" }),
  });
  const available = await send(
    {
      query: `query Engine($workspaceId: String) { officeEngine(workspaceId: $workspaceId) { __typename ... on OfficeEngineAvailable { id version } ... on OfficeEngineUnavailable { reason } ... on OfficeFailure { code } } }`,
      variables: { workspaceId: "project-1" },
    },
    withPack.office,
  );
  expect(available.body).toMatchObject({
    data: { officeEngine: { __typename: "OfficeEngineAvailable", id: "ibisoffice" } },
  });
  const withoutPack = port({
    engine: () => ({ __typename: "OfficeEngineUnavailable", reason: "no pack" }),
  });
  const unavailable = await send(
    {
      query: `query Engine($workspaceId: String) { officeEngine(workspaceId: $workspaceId) { __typename ... on OfficeEngineAvailable { id version } ... on OfficeEngineUnavailable { reason } ... on OfficeFailure { code } } }`,
      variables: { workspaceId: "project-1" },
    },
    withoutPack.office,
  );
  expect(unavailable.body).toMatchObject({
    data: { officeEngine: { __typename: "OfficeEngineUnavailable", reason: "no pack" } },
  });
});

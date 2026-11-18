import { expect, test } from "vitest";
import { createEdge } from "../edge/handler.ts";
import { createOfficePreviewFace } from "./face.ts";
import { SESSION_NAME_HEADER } from "../edge/env.ts";
import { envWith, sessionCookie, sessionWith } from "../../test/support/edge.ts";
/** The face over one edge-shaped request, with the name resolver a test supplies. */
function edgeWith(names: Readonly<Record<string, string>>, response?: Response) {
  const sessions = sessionWith(response);
  const edge = createEdge({
    graphql: () => Promise.resolve(new Response("{}", { status: 200 })),
    ws: () => Promise.resolve(new Response("ok")),
    office: (request) =>
      createOfficePreviewFace()(request, async (workspaceId) => names[workspaceId]),
  });
  return { edge, sessions };
}

/** One authenticated preview read. */
async function read(
  edge: ReturnType<typeof edgeWith>["edge"],
  sessions: ReturnType<typeof sessionWith>,
  query: string,
  options: { readonly cookie?: boolean; readonly method?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.cookie !== false) headers["cookie"] = await sessionCookie("owner");
  return await edge(
    new Request("https://hns.test/api/office/preview?" + query, {
      method: options.method ?? "GET",
      headers,
    }),
    envWith({ session: sessions.namespace }),
  );
}

// Catches: the edge handing the browser the object's answer through a buffer (a preview is
// tens of MiB), or forwarding the public path instead of the object's own RPC path (0237, C8).
test("an authenticated read forwards to the object and returns its stream unchanged", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\npreview");
  const { edge, sessions } = edgeWith(
    { "project-1": "project-1" },
    new Response(bytes, { headers: { "content-type": "application/pdf", "content-length": "15" } }),
  );
  const answer = await read(
    edge,
    sessions,
    "workspaceId=project-1&path=a.docx&v=sha256:" + "a".repeat(64),
  );
  expect(answer.status).toBe(200);
  expect(answer.headers.get("content-type")).toBe("application/pdf");
  expect(new Uint8Array(await answer.arrayBuffer())).toStrictEqual(bytes);
  const forwarded = sessions.requests[0];
  if (forwarded === undefined) throw new Error("nothing was forwarded");
  const url = new URL(forwarded.url);
  expect(url.pathname).toBe("/rpc/office/preview");
  expect(url.searchParams.get("workspaceId")).toBe("project-1");
  expect(url.searchParams.get("path")).toBe("a.docx");
  expect(forwarded.headers.get(SESSION_NAME_HEADER)).toBe("project-1");
});

// Catches: an anonymous caller reaching the object (D059: every REST face authenticates first).
test("an unauthenticated read is a 401 and forwards nothing", async () => {
  const { edge, sessions } = edgeWith({ "project-1": "project-1" });
  const answer = await read(
    edge,
    sessions,
    "workspaceId=project-1&path=a.docx&v=sha256:" + "a".repeat(64),
    {
      cookie: false,
    },
  );
  expect(answer.status).toBe(401);
  expect(sessions.requests).toHaveLength(0);
});

// Catches: a malformed read or a project this deployment does not have reaching an object (which
// would create one for a name nobody has, D080).
test("a malformed query is a 400, and an unknown workspace a 404, before any object", async () => {
  const { edge, sessions } = edgeWith({ "project-1": "project-1" });
  const malformed = await read(edge, sessions, "workspaceId=project-1&path=a.docx");
  expect(malformed.status).toBe(400);
  const unknown = await read(
    edge,
    sessions,
    "workspaceId=someone-else&path=a.docx&v=sha256:" + "a".repeat(64),
  );
  expect(unknown.status).toBe(404);
  expect(sessions.requests).toHaveLength(0);
});

// Catches: a non-GET method reaching the object, and a deployment with no office face answering
// as if the route did not exist.
test("only GET is answered, and an unwired face is a 503", async () => {
  const { edge, sessions } = edgeWith({ "project-1": "project-1" });
  const post = await read(
    edge,
    sessions,
    "workspaceId=project-1&path=a.docx&v=sha256:" + "a".repeat(64),
    {
      method: "POST",
    },
  );
  expect(post.status).toBe(405);
  const unwired = createEdge({
    graphql: () => Promise.resolve(new Response("{}", { status: 200 })),
    ws: () => Promise.resolve(new Response("ok")),
  });
  const answer = await unwired(
    new Request(
      "https://hns.test/api/office/preview?workspaceId=project-1&path=a.docx&v=sha256:" +
        "a".repeat(64),
      {
        headers: { cookie: await sessionCookie("owner") },
      },
    ),
    envWith({ session: sessions.namespace }),
  );
  expect(answer.status).toBe(503);
});

import { createServer } from "node:http";
import graphqlPkg from "graphql";
import DataLoader from "dataloader";
import { composeOverview } from "./compose.mjs";

const { buildSchema, graphql } = graphqlPkg;

export const SDL = `
type Query {
  overview(projectId: ID): Overview!
  conversations(projectId: ID): [Conversation!]!
}
type Overview { counts: Counts!, needs: [Item!]!, running: [Item!]!, completed: [Item!]!, asOf: String! }
type Counts { needsYou: Int!, running: Int!, doneToday: Int! }
type Item { kind: String!, id: ID!, title: String!, reason: String, updatedAt: String! }
type Conversation {
  id: ID!, projectId: ID!, title: String!, createdAt: String!,
  updatedAt: String, archived: Boolean!, deletedAt: String, live: Live
}
type Live { status: String!, needsReason: String, lastActivityAt: String!, queued: Int! }
`;

async function rpc(url, path, body) {
  const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

// mode: "fanout"  one RPC per conversation (the naive resolver)
//       "batch"   one RPC per workspace, batched per request
//       "d1"      the D1 mirror only, no RPC
export function startGql({ projection, sessions, wsConversations }) {
  const sessionOf = new Map();
  for (const [wsId, ids] of wsConversations) {
    const s = sessions.get(wsId);
    for (const id of ids) sessionOf.set(id, s);
  }
  const schema = buildSchema(SDL);

  function makeContext(mode) {
    const loaders = new Map();
    const loaderFor = (wsId) => {
      let l = loaders.get(wsId);
      if (l === undefined) {
        l = new DataLoader(async (ids) => {
          const { states } = await rpc(sessions.get(wsId).url, "/rpc/status", { ids });
          return ids.map((id) => states[id] ?? null);
        }, { cache: true });
        loaders.set(wsId, l);
      }
      return l;
    };
    return {
      mode,
      async liveMap(ids) {
        if (mode === "records") return new Map();
        if (mode === "d1") return projection.mirreredLive();
        if (mode === "batch") {
          const out = new Map();
          await Promise.all(ids.map(async (id) => out.set(id, await loaderFor(sessionOf.get(id).wsId).load(id))));
          return out;
        }
        const pairs = await Promise.all(ids.map(async (id) => {
          const { state } = await rpc(sessionOf.get(id).url, "/rpc/status-one", { id });
          return [id, state];
        }));
        return new Map(pairs);
      },
      async liveOf(id) {
        if (mode === "records") return null;
        if (mode === "d1") return projection.mirrorOf(id);
        if (mode === "batch") return loaderFor(sessionOf.get(id).wsId).load(id);
        const { state } = await rpc(sessionOf.get(id).url, "/rpc/status-one", { id });
        return state;
      },
    };
  }

  const rootValue = {
    async overview(args, ctx) {
      const projectId = args.projectId ?? null;
      const convs = projection.conversations(projectId);
      const tasks = projection.tasks(projectId);
      return composeOverview({ convRows: convs, taskRows: tasks, live: await ctx.liveMap(convs.map((c) => c.id)) });
    },
    conversations(args) {
      return projection.conversations(args.projectId ?? null).map((c) => ({
        id: c.id,
        projectId: c.project_id,
        title: c.title,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        archived: c.archived,
        deletedAt: c.deleted_at,
        live: (_a, ctx) => ctx.liveOf(c.id),
      }));
    },
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { query, variables, mode } = JSON.parse(body);
      const result = await graphql({ schema, source: query, rootValue, variableValues: variables, contextValue: makeContext(mode) });
      const text = JSON.stringify(result);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: "http://127.0.0.1:" + server.address().port, close: () => new Promise((d) => server.close(d)) });
    });
  });
}

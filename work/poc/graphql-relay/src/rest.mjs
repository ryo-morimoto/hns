import { createServer } from "node:http";
import { composeOverview } from "./compose.mjs";

const json = (res, value) => {
  const text = JSON.stringify(value);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

async function rpc(url, path, body) {
  const res = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// REST routes shaped like core's ROUTES: one endpoint per screen, each returning
// exactly the fields that screen needs. Line count is compared with gql.mjs.
export function startRest({ projection, sessions, wsConversations, model }) {
  const sessionOf = new Map();
  const convProject = new Map();
  let convCount = 0;
  for (const [wsId, ids] of wsConversations) {
    const s = sessions.get(wsId);
    for (const id of ids) {
      sessionOf.set(id, s);
      convProject.set(id, wsId);
      convCount += 1;
    }
  }

  async function liveBatched(convIds) {
    const groups = new Map();
    for (const id of convIds) {
      const s = sessionOf.get(id);
      const list = groups.get(s.wsId) ?? [];
      list.push(id);
      groups.set(s.wsId, list);
    }
    const results = await Promise.all(
      [...groups].map(async ([wsId, ids]) => (await rpc(sessions.get(wsId).url, "/rpc/status", { ids })).states),
    );
    return new Map(results.flatMap((states) => Object.entries(states)));
  }

  async function livePerConversation(convIds) {
    const results = await Promise.all(
      convIds.map(async (id) => {
        const { state } = await rpc(sessionOf.get(id).url, "/rpc/status-one", { id });
        return [id, state];
      }),
    );
    return new Map(results);
  }

  async function liveSerial(convIds) {
    const out = new Map();
    for (const id of convIds) {
      const { state } = await rpc(sessionOf.get(id).url, "/rpc/status-one", { id });
      out.set(id, state);
    }
    return out;
  }

  async function overview(projectId, live) {
    const convs = projection.conversations(projectId);
    const tasks = projection.tasks(projectId);
    return composeOverview({ convRows: convs, taskRows: tasks, live: await live(convs.map((c) => c.id)) });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    // The route 0115 replaces: one full conversation state per request.
    // messages / tasks are simplified (6 and 3 rows) but have the real field names.
    if (p === "/api/state") {
      const id = url.searchParams.get("conversationId");
      const { state } = await rpc(sessionOf.get(id).url, "/rpc/status-one", { id });
      const projectId = convProject.get(id);
      json(res, {
        messages: Array.from({ length: 6 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          text: "message " + String(i + 1) + " of " + id + ": gate の層を分ける話の続き",
        })),
        tasks: projection.tasks(projectId).slice(0, 3).map((t) => ({ id: t.id, kind: "task", state: t.status })),
        queued: state.queued,
        scheduling: "idle",
        provider: "opencode",
        model: "m",
        counts: { conversations: convCount, projects: model.workspaces.length },
      });
      return;
    }
    // The lean per-conversation read: the fair baseline for "1 request per conversation".
    if (p === "/api/live") {
      const id = url.searchParams.get("conversationId");
      const { state } = await rpc(sessionOf.get(id).url, "/rpc/status-one", { id });
      json(res, state);
      return;
    }
    if (p === "/api/overview-records") {
      json(res, await overview(url.searchParams.get("projectId"), async () => new Map()));
      return;
    }
    if (p === "/api/overview") {
      json(res, await overview(url.searchParams.get("projectId"), liveBatched));
      return;
    }
    if (p === "/api/overview-per-conversation") {
      json(res, await overview(url.searchParams.get("projectId"), livePerConversation));
      return;
    }
    if (p === "/api/overview-mirror") {
      json(res, await overview(url.searchParams.get("projectId"), async () => projection.mirreredLive()));
      return;
    }
    if (p === "/api/overview-serial") {
      json(res, await overview(url.searchParams.get("projectId"), liveSerial));
      return;
    }
    if (p === "/api/conversations") {
      const projectId = url.searchParams.get("projectId");
      const rows = projection.conversations(projectId);
      const summary = url.searchParams.get("fields") === "summary";
      const shaped = summary
        ? rows.map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, archived: c.archived }))
        : rows;
      if (url.searchParams.get("includeLive") !== "1") {
        json(res, shaped);
        return;
      }
      const live = await liveBatched(shaped.map((c) => c.id));
      json(
        res,
        shaped.map((c) => {
          const s = live.get(c.id) ?? null;
          return {
            ...c,
            live: s === null ? null : { status: s.status, needsReason: s.needsReason, lastActivityAt: s.lastActivityAt },
          };
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: "http://127.0.0.1:" + server.address().port, close: () => new Promise((d) => server.close(d)) });
    });
  });
}

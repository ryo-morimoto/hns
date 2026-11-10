// Edge router: one Durable Object instance holds the PoC session.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const id = env.SESSION.idFromName("poc");
      return await env.SESSION.get(id).fetch(request);
    }
    return new Response("hns cloudflare harness poc\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

export { Session } from "./session.js";

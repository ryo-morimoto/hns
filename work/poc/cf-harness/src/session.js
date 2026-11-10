// One Durable Object per PoC session: pi-durable's Harness on DO SQLite,
// with the execution environment on the machine reached over signed HTTP.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, configure, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRemoteEnv } from "./env.js";
import { createAgentClient, createMetrics } from "./rpc.js";

const HEARTBEAT_MS = 60_000;
const MODEL = { provider: "faux", modelId: "echo" };

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Deterministic four-step turn: bash, write, read, answer. */
const scriptFor = (state) => {
  const step = state.callCount % 4;
  if (step === 0) {
    return fauxAssistantMessage([fauxToolCall("bash", { command: "printf hello" }, { id: `call-${state.callCount}` })], { stopReason: "toolUse" });
  }
  if (step === 1) {
    return fauxAssistantMessage([
      fauxToolCall("write", { path: "poc.md", content: "hello from the durable object\n" }, { id: `call-${state.callCount}` }),
    ], { stopReason: "toolUse" });
  }
  if (step === 2) {
    return fauxAssistantMessage([fauxToolCall("read", { path: "poc.md" }, { id: `call-${state.callCount}` })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("done");
};

export class Session extends DurableObject {
  #harness;
  #ready;
  #conversationId;
  #faux;
  #metrics = createMetrics();

  constructor(ctx, env) {
    super(ctx, env);
    this.#ready = ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize() {
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const stored = await this.ctx.storage.get("conversationId");
    if (typeof stored === "number") this.#conversationId = stored;

    const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
    this.#faux = faux;
    // A step is consumed when used, so the factory re-queues itself for the next call.
    const respond = (context, options, state) => {
      faux.appendResponses([respond]);
      return scriptFor(state);
    };
    faux.setResponses([respond]);
    const models = createModels();
    models.setProvider(faux.provider);

    const call = createAgentClient(this.env, this.#metrics);
    const registry = createRegistry();
    registry.install(CodingTools);

    this.#harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { extensions: [CodingTools] },
        env: () => createRemoteEnv(call),
        onWake: (wake) => {
          void this.#arm(wake).catch((error) => console.error("arm failed", error));
        },
        onReport: (report) => console.error(JSON.stringify({ event: "harness_report", ...report })),
        conversationCreated: (tx, conversation) =>
          configure(tx, conversation.id, {
            model: MODEL,
            thinkingLevel: "off",
            extensions: [CodingTools],
            tools: CodingTools.tools,
          }),
      },
      BACKGROUND_CONTEXT,
    );

    void this.#harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("harness failed");
    });

    await this.#arm(this.#harness.wake());
    this.#harness.resume();
  }

  async #arm(wake) {
    const at = wake.active ? Date.now() + HEARTBEAT_MS : wake.at;
    if (at === undefined) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    await this.#ready;
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
    await this.#arm(this.#harness.wake());
  }

  async #conversation() {
    if (this.#conversationId !== undefined) {
      const current = await this.#harness.conversation(this.#conversationId, BACKGROUND_CONTEXT);
      if (current !== undefined) return current;
    }
    const id = await this.#harness.commit(
      async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
      BACKGROUND_CONTEXT,
    );
    this.#conversationId = id;
    await this.ctx.storage.put("conversationId", id);
    return await this.#harness.conversation(id, BACKGROUND_CONTEXT);
  }

  async fetch(request) {
    await this.#ready;
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/api/turn") {
        const body = await request.json();
        const text = typeof body?.text === "string" ? body.text : "hello";
        await this.#arm({ ...this.#harness.wake(), active: true });
        const conversation = await this.#conversation();
        const submission = await conversation.submit(
          { type: "input", content: text, requestId: crypto.randomUUID(), whenBusy: "followUp" },
          BACKGROUND_CONTEXT,
        );
        await this.#arm(this.#harness.wake());
        return json({ conversationId: this.#conversationId, submissionId: submission.id });
      }
      if (url.pathname === "/api/state") {
        return json({
          conversationId: this.#conversationId ?? null,
          active: this.#harness.wake().active,
          metrics: this.#metrics.snapshot(),
        });
      }
      if (url.pathname === "/api/debug") {
        const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
        let entries = [];
        if (this.#conversationId !== undefined) {
          const conversation = await this.#harness.conversation(this.#conversationId, BACKGROUND_CONTEXT);
          if (conversation !== undefined) {
            const page = await conversation.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
            entries = page.items.map((item) => String(JSON.stringify(item) ?? "").slice(0, 600));
          }
        }
        return json({
          entries,
          wake: this.#harness.wake(),
          conversationId: this.#conversationId ?? null,
          inspection,
          faux: this.#faux?.state,
        });
      }
      if (url.pathname === "/api/env-test") {
        const env = createRemoteEnv(createAgentClient(this.env, this.#metrics));
        const write = await env.writeFile("/notes/x.md", "hello");
        const read = await env.readTextFile("/notes/x.md");
        const info = await env.fileInfo("/notes/x.md");
        const listed = await env.listDir("/notes");
        const exec = await env.exec("printf hi", undefined, {});
        return json({ write, read, info, listed, exec });
      }
      if (url.pathname === "/api/ping-agent") {
        const call = createAgentClient(this.env, this.#metrics);
        try {
          const result = await call("health");
          return json({ ok: true, result });
        } catch (error) {
          return json({ ok: false, message: String(error?.message ?? error), stack: String(error?.stack ?? "") });
        }
      }
      if (url.pathname === "/api/metrics") {
        return json(this.#metrics.snapshot());
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        this.#metrics.reset();
        return json({ ok: true });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("session request failed", error);
      return json({ error: "internal", message: String(error?.message ?? error) }, 500);
    }
  }
}

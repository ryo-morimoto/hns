// Workspace v0.1: versioned read/write, a journal, and a seq'd event log on ExecutionEnv.
import { createHash } from "node:crypto";
import { getOrThrow } from "@earendil-works/pi-durable/env";

export class Denied extends Error {}
export class Crash extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

export class Workspace {
  #env; #root; #context; #journalPath; #crashAt;
  #canonicalRoot; #journal; #listeners = new Set(); #known = new Map(); #watcher; #timers = new Map();

  constructor({ env, root, journalPath, context, crashAt }) {
    this.#env = env; this.#root = root; this.#context = context;
    this.#journalPath = journalPath; this.#crashAt = crashAt;
  }

  async open() {
    this.#canonicalRoot = getOrThrow(await this.#env.canonicalPath(this.#root, this.#context));
    const read = await this.#env.readTextFile(this.#journalPath, this.#context);
    const loaded = read.ok ? JSON.parse(read.value) : {};
    this.#journal = { ops: loaded.ops ?? {}, seq: loaded.seq ?? 0, events: loaded.events ?? [] };
    for (const e of this.#journal.events) if (e.kind === "changed" || e.kind === "created") this.#known.set(e.path, e.version);
    return this;
  }

  #crash(step) { if (this.#crashAt === step) throw new Crash(step); }

  async #save() {
    await this.#env.writeFile(this.#journalPath, JSON.stringify(this.#journal), this.#context);
    await this.#env.flushFile(this.#journalPath, this.#context);
  }

  async #emit(event) {
    const seq = String(++this.#journal.seq);
    const e = { seq, at: new Date().toISOString(), ...event };
    this.#journal.events.push(e);
    if (this.#journal.events.length > 500) this.#journal.events.splice(0, this.#journal.events.length - 500);
    await this.#save();
    for (const listener of this.#listeners) listener(e);
    return e;
  }

  #normalize(relativePath) {
    if (!relativePath || relativePath.includes("\0")) throw new Denied("invalid path");
    if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) throw new Denied("absolute path");
    const parts = relativePath.split(/[\\/]+/);
    if (parts.includes("..")) throw new Denied("parent segment");
    return parts.filter((p) => p && p !== ".").join("/");
  }

  async #canonicalForWrite(abs) {
    try { return getOrThrow(await this.#env.canonicalPath(abs, this.#context)); }
    catch (error) {
      if (error?.code !== "not_found") throw error;
      const parent = getOrThrow(await this.#env.joinPath([abs, ".."], this.#context));
      if (parent === abs) throw new Denied("cannot resolve");
      const name = abs.slice(parent.length + (parent.endsWith("/") ? 0 : 1));
      return getOrThrow(await this.#env.joinPath([await this.#canonicalForWrite(parent), name], this.#context));
    }
  }

  async #resolve(relativePath) {
    const rel = this.#normalize(relativePath);
    const abs = await this.#canonicalForWrite(this.#joinRoot(rel));
    if (abs !== this.#canonicalRoot && !abs.startsWith(this.#canonicalRoot + "/")) throw new Denied("escapes root");
    return { rel, abs };
  }

  #joinRoot(rel) { return this.#canonicalRoot + (rel ? "/" + rel : ""); }

  async #versionOfFile(abs) {
    const read = await this.#env.readBinaryFile(abs, this.#context);
    if (!read.ok) { if (read.error.code === "not_found") return "absent"; throw read.error; }
    return sha(read.value);
  }

  async read(relativePath) {
    const { rel, abs } = await this.#resolve(relativePath);
    const read = await this.#env.readBinaryFile(abs, this.#context);
    if (!read.ok) throw read.error;
    return { path: rel, content: dec.decode(read.value), version: sha(read.value) };
  }

  async #reconcile(opId) {
    const rec = this.#journal.ops[opId];
    const current = await this.#versionOfFile(rec.abs);
    if (current === rec.contentHash) return this.#record(opId, { status: "applied", operationId: opId, version: rec.contentHash });
    if (current === rec.expectedVersion) return null;
    return this.#record(opId, { status: "unknown", operationId: opId, reason: "io" });
  }

  async #record(opId, outcome) {
    this.#journal.ops[opId].outcome = outcome;
    await this.#save();
    return outcome;
  }

  async write({ path, content, expectedVersion, operationId }) {
    const { rel, abs } = await this.#resolve(path);
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    const contentHash = sha(bytes);

    let rec = this.#journal.ops[operationId];
    if (rec?.outcome) return rec.outcome;
    if (rec && !rec.outcome) {
      const settled = await this.#reconcile(operationId);
      if (settled) return settled;
      rec = this.#journal.ops[operationId];
    }

    const current = await this.#versionOfFile(abs);
    const existed = current !== "absent";
    if (rec === undefined) {
      if (current !== expectedVersion) return { status: "conflict", operationId, currentVersion: current };
      rec = this.#journal.ops[operationId] = {
        abs, rel, expectedVersion, contentHash,
        temp: this.#canonicalRoot + "/.hns-tmp-" + operationId,
      };
      await this.#save();
      this.#crash("intent");
    }

    await this.#env.writeFile(rec.temp, bytes, this.#context);
    await this.#env.flushFile(rec.temp, this.#context);
    this.#crash("temp");

    const again = await this.#versionOfFile(abs);
    if (again !== expectedVersion) {
      await this.#env.remove(rec.temp, { force: true }, this.#context);
      return { status: "conflict", operationId, currentVersion: again };
    }

    await this.#env.renameFile(rec.temp, abs, this.#context);
    this.#crash("rename");

    const outcome = await this.#record(operationId, { status: "applied", operationId, version: contentHash });
    this.#known.set(rel, contentHash);
    await this.#emit({ kind: existed ? "changed" : "created", path: rel, version: contentHash });
    return outcome;
  }

  /** Reconcile every intent left without an outcome; call on startup. */
  async recover() {
    const settled = [];
    for (const [opId, rec] of Object.entries(this.#journal.ops)) {
      if (rec.outcome) continue;
      const outcome = await this.#reconcile(opId);
      settled.push({ operationId: opId, status: outcome ? outcome.status : "pending" });
    }
    return settled;
  }

  /** Watch the root through ExecutionEnv; emits changed / created / deleted / overflow. */
  async startWatching() {
    const result = await this.#env.watch([{ path: this.#canonicalRoot, recursive: true }], (change) => {
      void this.#onChange(change);
    }, this.#context);
    if (!result.ok) throw result.error;
    this.#watcher = result.value;
    return this.#watcher;
  }

  async #onChange(change) {
    if (change.kind === "overflow") { await this.#emit({ kind: "overflow" }); return; }
    if (change.kind === "failed") { await this.#emit({ kind: "overflow" }); return; }
    for (const abs of change.paths) {
      if (abs.includes("/.hns-tmp-")) continue;
      const rel = abs.startsWith(this.#canonicalRoot + "/") ? abs.slice(this.#canonicalRoot.length + 1) : undefined;
      if (rel === undefined) continue;
      const prior = this.#timers.get(rel);
      if (prior) clearTimeout(prior);
      this.#timers.set(rel, setTimeout(() => { this.#timers.delete(rel); void this.#settlePath(rel); }, 100));
    }
  }

  async #settlePath(rel) {
    const version = await this.#versionOfFile(this.#joinRoot(rel));
    if (version === "absent") {
      if (this.#known.delete(rel)) await this.#emit({ kind: "deleted", path: rel });
      return;
    }
    if (this.#known.get(rel) === version) return;
    const created = !this.#known.has(rel);
    this.#known.set(rel, version);
    await this.#emit({ kind: created ? "created" : "changed", path: rel, version });
  }

  /** Test hook: treat coverage as uncertain, as a reconnect would. */
  async overflow() { return this.#emit({ kind: "overflow" }); }

  /** Replay from `cursor` (exclusive), then stream. */
  async *watch(cursor = "0") {
    let last = Number(cursor) || 0;
    const queue = [];
    let wake;
    const listener = (e) => { queue.push(e); wake?.(); wake = null; };
    this.#listeners.add(listener);
    try {
      for (const e of this.#journal.events) if (Number(e.seq) > last) { last = Number(e.seq); yield e; }
      for (;;) {
        if (queue.length === 0) await new Promise((resolve) => (wake = resolve));
        for (const e of queue.splice(0)) if (Number(e.seq) > last) { last = Number(e.seq); yield e; }
      }
    } finally { this.#listeners.delete(listener); }
  }

  async close() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (this.#watcher) await this.#watcher.stop(this.#context);
  }
}
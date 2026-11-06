// Workspace v0.1: versioned read/write, a journal, and a seq'd event log on ExecutionEnv.
import { createHash, randomUUID } from "node:crypto";
import { getOrThrow } from "@earendil-works/pi-durable/env";

export class Denied extends Error {}
export class Crash extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

export class Workspace {
  #env; #root; #context; #journalPath; #crashAt;
  #canonicalRoot; #journal; #listeners = new Set(); #known = new Map(); #watcher; #timers = new Map();
  #identityPath; #identity; #beforeRename;

  constructor({ env, root, journalPath, context, crashAt, beforeRename }) {
    this.#env = env; this.#root = root; this.#context = context;
    this.#journalPath = journalPath; this.#crashAt = crashAt; this.#beforeRename = beforeRename;
  }

  async open() {
    this.#canonicalRoot = getOrThrow(await this.#env.canonicalPath(this.#root, this.#context));
    const read = await this.#env.readTextFile(this.#journalPath, this.#context);
    const loaded = read.ok ? JSON.parse(read.value) : {};
    this.#journal = { id: loaded.id, ops: loaded.ops ?? {}, seq: loaded.seq ?? 0, events: loaded.events ?? [], audit: loaded.audit ?? [] };
    for (const e of this.#journal.events) if (e.kind === "changed" || e.kind === "created") this.#known.set(e.path, e.version);
    this.#identityPath = this.#canonicalRoot + "/.hns/root.json";
    await this.#establishIdentity();
    return this;
  }

  #crash(step) { if (this.#crashAt === step) throw new Crash(step); }

  /**
   * Bind the workspace to this directory. The id lives in the Journal (outside the root);
   * the marker inside the root is a copy. A missing or different marker means the root was
   * replaced, and we fail closed.
   */
  async #establishIdentity() {
    const marker = await this.#env.readTextFile(this.#identityPath, this.#context);
    const markerId = marker.ok ? JSON.parse(marker.value).id : undefined;

    if (this.#journal.id === undefined) {
      const id = markerId ?? randomUUID();
      this.#journal.id = id;
      await this.#save();
      if (markerId === undefined) {
        await this.#env.writeFile(this.#identityPath, JSON.stringify({ id, createdAt: new Date().toISOString() }), this.#context);
        await this.#env.flushFile(this.#identityPath, this.#context);
      }
      this.#identity = id;
      return;
    }

    if (markerId !== this.#journal.id) throw new Denied("root replaced");
    this.#identity = this.#journal.id;
  }

  async #verifyIdentity() {
    const read = await this.#env.readTextFile(this.#identityPath, this.#context);
    if (!read.ok || JSON.parse(read.value).id !== this.#identity) throw new Denied("root replaced");
  }

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

  async #audit(entry) {
    const e = { at: new Date().toISOString(), ...entry };
    this.#journal.audit.push(e);
    if (this.#journal.audit.length > 500) this.#journal.audit.splice(0, this.#journal.audit.length - 500);
    await this.#save();
    return e;
  }

  /** Denied attempts, for the audit trail. */
  get auditLog() { return this.#journal.audit; }

  async #resolve(relativePath) {
    if (!getOrThrow(await this.#env.exists(this.#canonicalRoot, this.#context))) {
      throw new Denied("root missing");
    }
    await this.#verifyIdentity();
    const rel = this.#normalize(relativePath);
    const abs = await this.#canonicalForWrite(this.#joinRoot(rel));
    if (abs !== this.#canonicalRoot && !abs.startsWith(this.#canonicalRoot + "/")) throw new Denied("escapes root");
    return { rel, abs };
  }

  #joinRoot(rel) { return this.#canonicalRoot + (rel ? "/" + rel : ""); }

  /** Read through an opened handle, refusing a final symbolic link. */
  async #readBytes(abs) {
    const opened = await this.#env.openBinaryReader(abs, { noFollow: true }, this.#context);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    try {
      const info = getOrThrow(await reader.info(this.#context));
      const chunks = [];
      let offset = 0;
      while (offset < info.size) {
        const part = getOrThrow(await reader.read(offset, Math.min(1 << 20, info.size - offset), this.#context));
        if (part.length === 0) break;
        chunks.push(part); offset += part.length;
      }
      return Buffer.concat(chunks);
    } finally { await reader.close(this.#context); }
  }

  async #versionOfFile(abs) {
    try { return sha(await this.#readBytes(abs)); }
    catch (error) { if (error?.code === "not_found") return "absent"; throw error; }
  }

  async read(relativePath) {
    try {
      const { rel, abs } = await this.#resolve(relativePath);
      const bytes = await this.#readBytes(abs);
      return { path: rel, content: dec.decode(bytes), version: sha(bytes) };
    } catch (error) {
      if (error instanceof Denied) await this.#audit({ operationId: null, path: relativePath, reason: error.message, denied: true });
      throw error;
    }
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

  async write(input) {
    try { return await this.#write(input); }
    catch (error) {
      if (error instanceof Denied) await this.#audit({ operationId: input?.operationId ?? null, path: input?.path ?? null, reason: error.message, denied: true });
      throw error;
    }
  }

  async #write({ path, content, expectedVersion, operationId }) {
    const { rel, abs } = await this.#resolve(path);
    if (rel === ".git" || rel.startsWith(".git/")) {
      throw new Denied("git is read-only");
    }
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

    if (this.#beforeRename) await this.#beforeRename({ abs, rel });
    const parent = abs.slice(0, abs.lastIndexOf("/"));
    const parentNow = await this.#canonicalForWrite(parent);
    if (parentNow !== parent) {
      await this.#env.remove(rec.temp, { force: true }, this.#context);
      return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
    }
    try { await this.#verifyIdentity(); }
    catch (error) {
      if (error instanceof Denied) {
        await this.#env.remove(rec.temp, { force: true }, this.#context);
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
      throw error;
    }
    await this.#env.renameFile(rec.temp, abs, this.#context);
    // If a parent was swapped for a link during the rename, the target may now resolve outside.
    try {
      const after = await this.#canonicalForWrite(abs);
      if (after !== abs && !after.startsWith(this.#canonicalRoot + "/")) {
        await this.#audit({ operationId, path: rel, reason: "escaped after rename", denied: true });
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
    } catch {}
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
      if (abs.includes("/.hns-tmp-") || abs.includes("/.hns/")) continue;
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
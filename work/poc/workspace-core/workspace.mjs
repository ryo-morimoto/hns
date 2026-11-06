// Workspace v0.1: versioned read/write with a journal, built on ExecutionEnv.
import { createHash } from "node:crypto";
import { getOrThrow } from "@earendil-works/pi-durable/env";

export class Denied extends Error {}
export class Crash extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const resultOf = (r) => (r.ok ? r.value : r.error);

export class Workspace {
  #env; #root; #context; #journalPath; #journal; #crashAt;
  #canonicalRoot;

  constructor({ env, root, journalPath, context, crashAt }) {
    this.#env = env; this.#root = root; this.#context = context;
    this.#journalPath = journalPath; this.#crashAt = crashAt;
  }

  async open() {
    this.#canonicalRoot = getOrThrow(await this.#env.canonicalPath(this.#root, this.#context));
    const read = await this.#env.readTextFile(this.#journalPath, this.#context);
    this.#journal = read.ok ? JSON.parse(read.value) : { ops: {} };
    return this;
  }

  #crash(step) { if (this.#crashAt === step) throw new Crash(step); }

  async #save() {
    await this.#env.writeFile(this.#journalPath, JSON.stringify(this.#journal), this.#context);
    await this.#env.flushFile(this.#journalPath, this.#context);
  }

  #normalize(relativePath) {
    if (!relativePath || relativePath.includes("\0")) throw new Denied("invalid path");
    if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) throw new Denied("absolute path");
    const parts = relativePath.split(/[\\/]+/);
    if (parts.includes("..")) throw new Denied("parent segment");
    return parts.filter((p) => p && p !== ".").join("/");
  }

  async #resolve(relativePath) {
    const rel = this.#normalize(relativePath);
    const abs = getOrThrow(await this.#env.joinPath([this.#canonicalRoot, rel], this.#context));
    let canonical;
    try { canonical = getOrThrow(await this.#env.canonicalPath(abs, this.#context)); }
    catch (error) {
      if (error?.code !== "not_found") throw error;
      const parent = getOrThrow(await this.#env.joinPath([abs, ".."], this.#context));
      const canonicalParent = getOrThrow(await this.#env.canonicalPath(parent, this.#context));
      const name = abs.slice(parent.length + (parent.endsWith("/") ? 0 : 1));
      canonical = getOrThrow(await this.#env.joinPath([canonicalParent, name], this.#context));
    }
    if (canonical !== this.#canonicalRoot && !canonical.startsWith(this.#canonicalRoot + "/")) {
      throw new Denied("escapes root");
    }
    return { abs: canonical, rel };
  }

  async #versionOfFile(abs) {
    const read = await this.#env.readBinaryFile(abs, this.#context);
    if (!read.ok) {
      if (read.error.code === "not_found") return "absent";
      throw read.error;
    }
    return sha(read.value);
  }

  async read(relativePath) {
    const { abs, rel } = await this.#resolve(relativePath);
    const read = await this.#env.readBinaryFile(abs, this.#context);
    if (!read.ok) throw read.error;
    return { path: rel, content: dec.decode(read.value), version: sha(read.value) };
  }

  /** Resolve an intent that has no outcome yet. Returns an outcome, or null when the write did not happen. */
  async #reconcile(opId) {
    const rec = this.#journal.ops[opId];
    const current = await this.#versionOfFile(rec.abs);
    if (current === rec.contentHash) return this.#record(opId, { status: "applied", operationId: opId, version: rec.contentHash });
    if (current === rec.expectedVersion) return null;
    // Neither side matches: we cannot tell whether the rename happened and was overwritten.
    return this.#record(opId, { status: "unknown", operationId: opId, reason: "io" });
  }

  async #record(opId, outcome) {
    this.#journal.ops[opId].outcome = outcome;
    await this.#save();
    return outcome;
  }

  async write({ path, content, expectedVersion, operationId }) {
    const { abs, rel } = await this.#resolve(path);
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    const contentHash = sha(bytes);

    let rec = this.#journal.ops[operationId];
    if (rec?.outcome) return rec.outcome;                       // replay: recorded result
    if (rec && !rec.outcome) {                                  // intent from a crashed attempt
      const settled = await this.#reconcile(operationId);
      if (settled) return settled;
      rec = this.#journal.ops[operationId];
    }

    const current = await this.#versionOfFile(abs);
    if (rec === undefined) {
      if (current !== expectedVersion) {
        return { status: "conflict", operationId, currentVersion: current };
      }
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

    return this.#record(operationId, { status: "applied", operationId, version: contentHash });
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
}
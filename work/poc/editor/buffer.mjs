// EditorBuffer: what the user has typed, versus what the workspace holds.
// IO is injected so the state machine can be tested without HTTP.
export class EditorBuffer {
  path; content = ""; baseVersion = "absent"; savedContent = ""; conflict = null;
  #read; #save;

  constructor({ read, save }) { this.#read = read; this.#save = save; }

  async open(path) {
    const result = await this.#read(path);
    this.path = path;
    this.content = result.content;
    this.savedContent = result.content;
    this.baseVersion = result.version;
    this.conflict = null;
    return this;
  }

  get dirty() { return this.content !== this.savedContent; }

  edit(next) { this.content = next; }

  /** Save the local content; on conflict the local content and the conflict are kept. */
  async save(operationId) {
    if (!this.dirty) return { status: "unchanged" };
    const outcome = await this.#save({
      path: this.path, content: this.content,
      expectedVersion: this.baseVersion, operationId,
    });
    if (outcome.status === "applied") {
      this.baseVersion = outcome.version;
      this.savedContent = this.content;
      this.conflict = null;
    } else if (outcome.status === "conflict") {
      const external = await this.#read(this.path).catch(() => undefined);
      this.conflict = { currentVersion: outcome.currentVersion, external };
    }
    return outcome;
  }

  /** Discard local edits and take the workspace's content. */
  async reload() { return this.open(this.path); }

  /** Keep the local content and overwrite the version that won the conflict. */
  async overwrite(operationId) {
    if (this.conflict === null) return { status: "unchanged" };
    const outcome = await this.#save({
      path: this.path, content: this.content,
      expectedVersion: this.conflict.currentVersion, operationId,
    });
    if (outcome.status === "applied") {
      this.baseVersion = outcome.version;
      this.savedContent = this.content;
      this.conflict = null;
    }
    return outcome;
  }
}
import * as v from "valibot";

/**
 * What every helper call carries: which root, and which directory must still be there.
 *
 * @remarks
 * `root` must be absolute. `id` is the journal identity: the helper reads the
 * root's own marker through the opened dirfd and refuses one that names another
 * workspace, so a swapped directory cannot impersonate the root. `dev` and
 * `ino` are the ones the probe recorded; they are absent only while probing.
 *
 * @internal
 */
export interface HelperBase {
  readonly root: string;
  /** Journal id; the helper refuses a root whose marker names another one. */
  readonly id: string;
  /** Device and inode of the root recorded by the probe; absent while probing. */
  readonly dev?: number | undefined;
  readonly ino?: number | undefined;
}

const HELPER_OPS = ["probe", "hash", "read", "commit"] as const;
/**
 * The helper operations, in one closed vocabulary.
 *
 * @remarks
 * Each request runs one helper process, and the op name is also its first argv
 * word, so the helper can check it before reading paths.
 *
 * @internal
 */
export type HelperOp = (typeof HELPER_OPS)[number];

/**
 * One operation, as argv: the op name and JSON. Every path is a list of names
 * below the root, so the helper never sees ".." or an absolute path.
 *
 * @remarks
 * `commit` names the target as names below the root and the temp as a single
 * name beside it, because the helper renames from one dirfd to another. The
 * helper re-validates every component; this type only carries them.
 *
 * @internal
 */
export type HelperRequest =
  | (HelperBase & { readonly op: "probe" })
  | (HelperBase & { readonly op: "hash"; readonly path: readonly string[] })
  | (HelperBase & { readonly op: "read"; readonly path: readonly string[] })
  | (HelperBase & {
      readonly op: "commit";
      readonly path: readonly string[];
      readonly temp: string;
      readonly expectedVersion: string;
    });

/**
 * What the helper prints. The client checks the shape before using it.
 *
 * @remarks
 * This is untrusted text from another process: a reply that does not match one
 * of these variants becomes a failed outcome, never a trusted value.
 *
 * @internal
 */
export type HelperReply =
  | { readonly ok: true; readonly dev: number; readonly ino: number }
  | { readonly ok: true; readonly version: string }
  | { readonly ok: true; readonly base64: string; readonly size: number }
  | { readonly ok: true; readonly status: "applied" }
  | { readonly ok: true; readonly status: "conflict"; readonly currentVersion: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * What the client reports to the workspace, after checking the reply.
 *
 * @remarks
 * `failed` keeps the helper's code vocabulary (`not_found`, `root_replaced`,
 * `root_missing`, `invalid`, ...) so the workspace can map it to a Denied or a
 * FileFailure instead of parsing a message.
 *
 * @internal
 */
export type HelperOutcome =
  | { readonly kind: "probe"; readonly dev: number; readonly ino: number }
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "content"; readonly bytes: Uint8Array }
  | { readonly kind: "applied" }
  | { readonly kind: "conflict"; readonly currentVersion: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

const rootFields = {
  root: v.pipe(v.string(), v.regex(/^\//)),
  id: v.string(),
  dev: v.optional(v.number()),
  ino: v.optional(v.number()),
};

const RequestSchema: v.GenericSchema<unknown, HelperRequest> = v.variant("op", [
  v.object({ ...rootFields, op: v.literal("probe") }),
  v.object({ ...rootFields, op: v.literal("hash"), path: v.array(v.string()) }),
  v.object({ ...rootFields, op: v.literal("read"), path: v.array(v.string()) }),
  v.object({
    ...rootFields,
    op: v.literal("commit"),
    path: v.array(v.string()),
    temp: v.string(),
    expectedVersion: v.string(),
  }),
]);

const ReplySchema = v.union([
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  v.object({ ok: v.literal(true), dev: v.number(), ino: v.number() }),
  v.object({ ok: v.literal(true), version: v.string() }),
  v.object({
    ok: v.literal(true),
    base64: v.string(),
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.object({ ok: v.literal(true), status: v.literal("applied") }),
  v.object({ ok: v.literal(true), status: v.literal("conflict"), currentVersion: v.string() }),
]);

/** The marker inside the root, which names the workspace that owns it. */
const MarkerSchema = v.object({ id: v.string() });

/**
 * Parse what the workspace passed to the helper. Throws on anything else.
 *
 * @param text - The JSON payload from argv.
 * @returns A request whose root is absolute and whose path is a string array.
 * The path components are checked by `namesOf` before the helper uses them.
 * @throws When the payload is not JSON, or does not match a request shape: a
 * syntax error or valibot's validation error.
 *
 * @internal
 */
export function parseRequest(text: string): HelperRequest {
  return v.parse(RequestSchema, JSON.parse(text));
}

const failed = (code: string, message: string): HelperOutcome => ({
  kind: "failed",
  code,
  message,
});

/**
 * Turn the helper's stdout into an outcome the workspace can act on.
 *
 * @param op - The request that produced the reply; the reply must fit its shape.
 * @param text - The helper's stdout.
 * @returns An outcome; malformed output becomes `failed("io", ...)` rather than
 * an exception, because a helper that printed nothing is a failed operation and
 * not a crash in the caller.
 *
 * @internal
 */
export function parseReply(op: HelperOp, text: string): HelperOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failed("io", "the helper printed nothing usable");
  }
  const parsed = v.safeParse(ReplySchema, raw);
  if (!parsed.success) return failed("io", "the helper reply is unreadable");
  const reply = parsed.output;
  if (!reply.ok) return failed(reply.code, reply.message);
  switch (op) {
    case "probe":
      return "dev" in reply
        ? { kind: "probe", dev: reply.dev, ino: reply.ino }
        : failed("io", "no device");
    case "hash":
      return "version" in reply
        ? { kind: "version", version: reply.version }
        : failed("io", "no version");
    case "read": {
      if (!("base64" in reply) || !("size" in reply)) return failed("io", "no content");
      const bytes = Buffer.from(reply.base64, "base64");
      // Base64 decoders drop bad characters, so the length is the only sign of a cut reply.
      if (bytes.length !== reply.size) return failed("io", "the helper reply is the wrong length");
      return { kind: "content", bytes };
    }
    case "commit":
      if (!("status" in reply)) return failed("io", "no verdict");
      if (reply.status === "applied") return { kind: "applied" };
      return "currentVersion" in reply
        ? { kind: "conflict", currentVersion: reply.currentVersion }
        : failed("io", "no conflicting version");
  }
}

/**
 * The id a root marker names, or undefined when the text is not one.
 *
 * @param text - The raw marker file body.
 * @returns The marker's id, or undefined for absent, unparsable, or shapeless
 * text. Callers decide what undefined means: an existing workspace refuses, while
 * a new workspace may mint an id.
 *
 * @internal
 */
export function parseMarker(text: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = v.safeParse(MarkerSchema, raw);
  return parsed.success ? parsed.output.id : undefined;
}

import * as v from "valibot";

/** What every helper call carries: which root, and which directory must still be there. */
export interface HelperBase {
  readonly root: string;
  /** Journal id; the helper refuses a root whose marker names another one. */
  readonly id: string;
  /** Device and inode of the root recorded by the probe; absent while probing. */
  readonly dev?: number | undefined;
  readonly ino?: number | undefined;
}

export const HELPER_OPS = ["probe", "hash", "read", "commit"] as const;
export type HelperOp = (typeof HELPER_OPS)[number];

/**
 * One operation, as argv: the op name and JSON. Every path is a list of names
 * below the root, so the helper never sees ".." or an absolute path.
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

/** What the helper prints. The client checks the shape before using it. */
export type HelperReply =
  | { readonly ok: true; readonly dev: number; readonly ino: number }
  | { readonly ok: true; readonly version: string }
  | { readonly ok: true; readonly base64: string }
  | { readonly ok: true; readonly status: "applied" }
  | { readonly ok: true; readonly status: "conflict"; readonly currentVersion: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** What the client reports to the workspace, after checking the reply. */
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
  v.object({ ok: v.literal(true), base64: v.string() }),
  v.object({ ok: v.literal(true), status: v.literal("applied") }),
  v.object({ ok: v.literal(true), status: v.literal("conflict"), currentVersion: v.string() }),
]);

/** The marker inside the root, which names the workspace that owns it. */
const MarkerSchema = v.object({ id: v.string() });

/** Parse what the workspace passed to the helper. Throws on anything else. */
export function parseRequest(text: string): HelperRequest {
  return v.parse(RequestSchema, JSON.parse(text));
}

const failed = (code: string, message: string): HelperOutcome => ({
  kind: "failed",
  code,
  message,
});

/** Turn the helper's stdout into an outcome the workspace can act on. */
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
    case "read":
      return "base64" in reply
        ? { kind: "content", bytes: Buffer.from(reply.base64, "base64") }
        : failed("io", "no content");
    case "commit":
      if (!("status" in reply)) return failed("io", "no verdict");
      if (reply.status === "applied") return { kind: "applied" };
      return "currentVersion" in reply
        ? { kind: "conflict", currentVersion: reply.currentVersion }
        : failed("io", "no conflicting version");
  }
}

/** The id a root marker names, or undefined when the text is not one. */
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

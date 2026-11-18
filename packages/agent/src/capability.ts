import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { err, ok } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import { isoTimestamp } from "@hns/core";
import {
  UnsupportedFormatError,
  canonicalize,
  digestCall,
  manifestHash,
  normalizePath,
  sha256Hex,
} from "@hns/core/capability";
import type {
  AuditEvent,
  AuditEventBase,
  CallDigest,
  DenialCode,
  DenyDecision,
  PolicyDecision,
  ToolCall,
  ToolId,
  ToolManifest,
  ToolRisk,
} from "@hns/core/capability";
import * as v from "valibot";
import type { AgentEventSink } from "./events.ts";
import type { ToolFailure } from "./failure.ts";

/**
 * One tool call as the capability contract names it: the manifest it was made against, the call
 * itself, the hashes of both, and the decision it runs under (`docs/capability.md` §3–§4, D091).
 *
 * @remarks
 * The types, JCS, hashes, path rules, and denial vocabulary are `@hns/core/capability`; this module
 * builds the values the agent side owns — the three tool contracts, a call from one invocation, and
 * the Phase 0 decision — and never re-implements a hash. Phase 0 carries no grant: a call is recorded
 * under the Phase 0 allow, and `grantId` is absent because no grant was presented.
 *
 * Each tool has **one** argument type, parsed at the tool's own boundary: the model's JSON leaves as
 * {@link ReadFileArguments}, {@link WriteFileArguments}, or {@link BashArguments}, and nothing inside
 * this module handles a bare dictionary of unknowns.
 */

/**
 * The version of every Phase 0 manifest.
 *
 * @remarks
 * `"1"` fixes the hash of each tool's contract; the version changes when the behaviour its description
 * promises changes (`docs/capability.md` §3). Whether it advances per tool or as one counter is still
 * open (0221's notes), so Phase 0 pins it.
 */
export const TOOL_VERSION = "1";

/** `policyRevision` of a Phase 0 allow: Phase 0 has no policy revision (0223 stores those). */
export const PHASE0_POLICY_REVISION = 0;

/**
 * `policyHash` of a Phase 0 allow: `sha256Hex("hns.phase0")`.
 *
 * @remarks
 * It names "no policy document yet" in a field the contract requires: `allow` cannot exist without a
 * revision and a hash, and a constant that says so is better than a revision an auditor cannot find.
 */
export const PHASE0_POLICY_HASH =
  "f6dc6fef7b106db4d1ed1310b920f414fad006978681999a0aa6313054a53f02";

/**
 * The code a refusal is recorded with when a call's arguments are not the shape the tool declares.
 *
 * @remarks
 * The contract's closed vocabulary has no code for a malformed argument: `tool_disabled` means the
 * tool is off (a policy question), and these arguments never became a call it could judge.
 * `unsupported` is the contract's "cannot be decided as a call", which is what an unknown key or a
 * `timeout` in another unit is. A dedicated code would be a change to the vocabulary (`DENIAL_CODES`
 * / `DENIAL_RETRY`, 0220), proposed to its owner.
 */
export const INVALID_ARGUMENTS: DenialCode = "unsupported";

/**
 * The exec envelope a Phase 0 bash call runs in.
 *
 * @remarks
 * `{kind:"exec", network:"none", writable:false}` is the workspace sandbox Phase 0 offers (D025,
 * `docs/capability.md` §6). It travels inside the call's `args.envelope`, where core's `authorizeCall`
 * looks for an exec scope — so the envelope is **part of the call's identity**: the same command under
 * a wider envelope is a different `argsHash` and a different `callHash`.
 */
export const PHASE0_EXEC_ENVELOPE = {
  kind: "exec",
  network: "none",
  writable: false,
} as const;

/** The envelope a bash call is recorded with. */
export type ExecEnvelope = typeof PHASE0_EXEC_ENVELOPE;

/** The arguments of a `read_file` call, after the tool's schema: the path it will read. */
export interface ReadFileArguments {
  readonly path: string;
}

/** The arguments of a `write_file` call, after the tool's schema. */
export interface WriteFileArguments {
  readonly path: string;
  readonly content: string;
  readonly expectedVersion: string;
}

/**
 * The arguments of a `bash` call, after the tool's schema: what the model wrote, plus its envelope.
 *
 * @remarks
 * `timeoutMs` is milliseconds — a whole number, because the contract's canonical JSON accepts safe
 * integers only (pi-durable's bash takes seconds, and the agent converts once at that boundary). It is
 * present only when the model wrote it. `envelope` is the agent's, not the model's.
 */
export interface BashArguments {
  readonly command: string;
  readonly timeoutMs?: number | undefined;
  readonly envelope: ExecEnvelope;
}

/** The model's arguments of a bash call, before the agent adds the envelope. */
export interface BashInput {
  readonly command: string;
  readonly timeoutMs?: number | undefined;
}

/** Every workspace tool's arguments. */
export type ToolArguments = ReadFileArguments | WriteFileArguments | BashArguments;

/** `read_file`'s schema: the model's arguments, parsed. */
const ReadFileSchema: v.GenericSchema<unknown, ReadFileArguments> = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
});

/** `write_file`'s schema: the model's arguments, parsed. */
const WriteFileSchema: v.GenericSchema<unknown, WriteFileArguments> = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
  content: v.string(),
  expectedVersion: v.pipe(v.string(), v.minLength(1)),
});

/**
 * `bash`'s schema: the model's arguments, parsed, without the envelope the agent adds.
 *
 * @remarks
 * `timeoutMs` alone: a positive whole number of milliseconds. pi-durable's bash takes `timeout` in
 * seconds, but that is the agent's boundary to convert (`harnessArguments`), not a second name for the
 * model to write: a call that writes `timeout` is refused here as an unknown key (the agent refuses it
 * before admission too), so the call is hashed over one spelling of its timeout and nothing runs.
 */
const BashSchema: v.GenericSchema<unknown, BashInput> = v.strictObject({
  command: v.pipe(v.string(), v.minLength(1)),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/** A JSON Schema value: the shapes these descriptors are made of. */
export type JsonSchemaValue =
  | string
  | number
  | { readonly [keyword: string]: JsonSchemaValue }
  | readonly JsonSchemaValue[];

/** A JSON Schema object: the one shape a manifest's parameter descriptor is. */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaValue>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/**
 * What one workspace tool is made of, before it becomes a manifest.
 *
 * @remarks
 * `defineTool` and the manifest read the same definition, so the text the model is shown and the bytes
 * the manifest hashes cannot drift by editing one of them. `schema` is the tool's own `strictObject`;
 * `parameters` is the descriptor the manifest hashes, describing the same arguments.
 */
export interface WorkspaceToolDefinition {
  readonly toolId: ToolId;
  readonly version: string;
  /** What the model reads, verbatim. */
  readonly description: string;
  /** The tool's schema: a `strictObject`, so an unknown key is a refusal. */
  readonly schema: v.GenericSchema<unknown, ToolArguments | BashInput>;
  /** Every parameter's JSON Schema, which the manifest hashes as the tool's descriptor. */
  readonly parameters: JsonSchemaObject;
  readonly risk: ToolRisk;
  readonly outputLimits: ToolManifest["outputLimits"];
}

/** The workspace tools, in registration order. */
export const WORKSPACE_TOOLS: readonly WorkspaceToolDefinition[] = [
  {
    toolId: "read_file",
    version: TOOL_VERSION,
    description:
      "Read a workspace file. Returns JSON {ok, content, version} or {ok:false, status, message}.",
    schema: ReadFileSchema,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    risk: "read",
    // The tool bounds its own content below this; the harness's limit must leave the JSON envelope room.
    outputLimits: { maxBytes: 256 * 1024, maxLines: 40_000 },
  },
  {
    toolId: "write_file",
    version: TOOL_VERSION,
    description:
      "Replace a workspace file. expectedVersion is the version from read_file, or 'absent'. Returns JSON " +
      "{status:'applied'|'conflict'|'unknown'} so a conflict can be re-read instead of retried blindly.",
    schema: WriteFileSchema,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedVersion: { type: "string" },
      },
      required: ["path", "content", "expectedVersion"],
      additionalProperties: false,
    },
    risk: "write",
    // A conflict repeats the path and a short reason, never the content that was offered.
    outputLimits: { maxBytes: 64 * 1024, maxLines: 1_000 },
  },
  {
    toolId: "bash",
    version: TOOL_VERSION,
    description:
      "Run a command in the workspace shell, waiting timeoutMs milliseconds at most. Output is the " +
      "command's stdout and stderr, bounded; a nonzero exit is an error result that still carries the " +
      "output.",
    schema: BashSchema,
    // The model-facing descriptor: a timeout is a whole number of milliseconds.
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeoutMs: { type: "integer" } },
      required: ["command"],
      additionalProperties: false,
    },
    risk: "exec",
    // The harness keeps the tail, as pi-durable's bash does; these match its defaults.
    outputLimits: { maxBytes: 50 * 1024, maxLines: 2_000 },
  },
];

/**
 * The definition of one workspace tool.
 *
 * @throws Error when no tool has that id; the table is fixed at build time.
 */
export function definitionOf(toolId: ToolId): WorkspaceToolDefinition {
  const definition = WORKSPACE_TOOLS.find((tool) => tool.toolId === toolId);
  if (definition === undefined) throw new Error("no workspace tool named " + toolId);
  return definition;
}

/** A tool's contract and the hash every call of it is recorded against. */
export interface ToolIdentity {
  readonly definition: WorkspaceToolDefinition;
  readonly manifest: ToolManifest;
  readonly manifestHash: string;
}

/**
 * Build a tool's manifest: its identity, description hash, parameter hash, risk, and output limits.
 *
 * @param definition - The tool's contract.
 * @returns The manifest and its `manifestHash` = `sha256Hex(JCS(manifest))`.
 *
 * @remarks
 * `descriptionHash` and `parametersHash` hash what the model was shown, not any code: a changed
 * description or parameter is a changed contract and a changed `manifestHash` (`docs/capability.md`
 * §4). The parameters are hashed as the JSON Schema text, which is the form a model receives.
 */
export async function manifestFor(definition: WorkspaceToolDefinition): Promise<ToolIdentity> {
  const manifest: ToolManifest = {
    v: 1,
    toolId: definition.toolId,
    version: definition.version,
    descriptionHash: await sha256Hex(canonicalize(definition.description)),
    parametersHash: await sha256Hex(canonicalize(definition.parameters)),
    risk: definition.risk,
    outputLimits: {
      maxBytes: definition.outputLimits.maxBytes,
      maxLines: definition.outputLimits.maxLines,
    },
  };
  return { definition, manifest, manifestHash: await manifestHash(manifest) };
}

/** One call: the contract's call, its digest, and the tool it was made of. */
export interface CallIdentity {
  readonly call: ToolCall;
  readonly digest: CallDigest;
  readonly identity: ToolIdentity;
}

/**
 * Build the contract's `ToolCall` for one invocation.
 *
 * @param identity - The tool's manifest.
 * @param callId - pi-durable's id for the invocation, `"tool:<ms>:<id>"`.
 * @param args - The arguments the tool's own checks accepted.
 * @returns The call and its `argsHash` / `callHash`.
 *
 * @remarks
 * `callId` comes from the durable call, never from the model's arguments, so a model cannot repeat an
 * id to reuse an authorization (`docs/capability.md` §4). A value with no canonical form makes
 * `digestCall` throw `UnsupportedFormatError`, which the caller turns into `unsupported`.
 */
export async function callIdentity(
  identity: ToolIdentity,
  callId: string,
  args: ToolArguments,
): Promise<CallIdentity> {
  const call: ToolCall = {
    v: 1,
    callId,
    toolId: identity.definition.toolId,
    toolVersion: identity.definition.version,
    args: argsRecord(args),
  };
  return { call, digest: await digestCall(call), identity };
}

/**
 * A call's arguments as the contract's record: exactly the members the tool's schema declared.
 *
 * @param args - One tool's parsed arguments.
 * @returns The plain record a `ToolCall` carries; an absent `timeoutMs` is not a member.
 *
 * @remarks
 * `ToolCall["args"]` is the contract's own untrusted payload (`Record<string, unknown>`), and this is
 * the one place typed arguments become it — built member by member, so no other key can appear.
 */
function argsRecord(args: ToolArguments): ToolCall["args"] {
  if (isBashArguments(args)) {
    return args.timeoutMs === undefined
      ? { command: args.command, envelope: args.envelope }
      : { command: args.command, timeoutMs: args.timeoutMs, envelope: args.envelope };
  }
  if (isWriteFileArguments(args)) {
    return { path: args.path, content: args.content, expectedVersion: args.expectedVersion };
  }
  return { path: args.path };
}

/** Whether the arguments are a bash call's (they carry the exec envelope). */
function isBashArguments(args: ToolArguments): args is BashArguments {
  return "envelope" in args;
}

/** Whether the arguments carry a write's content. */
export function isWriteFileArguments(args: ToolArguments): args is WriteFileArguments {
  return "content" in args;
}

/**
 * The decision a Phase 0 call runs under.
 *
 * @returns The allow every call that passed the tool's own checks is recorded with.
 *
 * @remarks
 * Phase 0 presents no grant, so the allow names no `grantId`: the optional key is absent, not
 * `undefined` (`exactOptionalPropertyTypes`). Phase 1 replaces this with `authorizeCall`'s answer.
 */
export function phase0Allow(): PolicyDecision {
  return {
    outcome: "allow",
    policyRevision: PHASE0_POLICY_REVISION,
    policyHash: PHASE0_POLICY_HASH,
  };
}

/**
 * The decision that refuses a call.
 *
 * @param code - A code from the contract's closed denial vocabulary.
 * @param message - What the model may read; it carries no raw argument and no secret.
 * @returns The deny decision.
 */
export function phase0Deny(code: DenialCode, message: string): DenyDecision {
  return { outcome: "deny", code, message };
}

/** What a refusal is as the model reads it: a value, never an exception. */
export type CapabilityRefusal = ToolFailure & {
  readonly ok: false;
  readonly status: "denied";
  readonly code: DenialCode;
  readonly message: string;
};

/**
 * Turn a decision into the refusal the model reads.
 *
 * @param decision - A deny decision.
 * @returns `{ok:false, status:"denied", code, message}`.
 */
export function refusalOf(decision: DenyDecision): CapabilityRefusal {
  return { ok: false, status: "denied", code: decision.code, message: decision.message };
}

/**
 * Parse the arguments of a call from the JSON text a model produced.
 *
 * @param raw - A tool call's `arguments` before any object was built from it.
 * @returns The object's own keys, each mapped to itself, or the reason the text is not one object.
 *
 * @remarks
 * **This is the boundary where duplicate keys are refused.** `JSON.parse` keeps the last of two equal
 * keys and reports nothing, and a reviver runs after the fold, so the check reads the text: a repeated
 * key is refused inside every object at every depth, after decoding (`"a"` and `"\u0061"` are one
 * key). Malformed text, a non-object, and trailing content are refused too. The values stay a tool's
 * to parse; this returns the keys the text did carry, which is enough to know the object was one.
 *
 * **A model's own call does not reach here.** pi-durable parses a tool call's `arguments` before it
 * calls a tool, so a duplicate on that path was already folded; the tool's `v.strictObject` still
 * refuses an unknown or ill-typed key. This function is for the boundaries that do receive raw text —
 * a code-mode `executeTool` call with a JSON string argument, a machine RPC, and 0226's runtime — and
 * each of them must parse through it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a raw JSON string is this boundary's input.
/* oxlint-disable anti-slop/no-runtime-typeof --
   `parseJsonArguments` is the raw-JSON boundary: `JSON.parse` yields an unknown JSON value, and the
   check that it is the object the scanner just walked is a `typeof` on that value by necessity. */
export function parseJsonArguments(raw: string): Result<Record<string, string>, string> {
  const scan = scanJson(raw);
  if (scan.kind === "invalid") return err(scan.reason);
  // The text passed the scanner, which already refused a non-object, a repeated key, and trailing
  // content; `JSON.parse` then yields a plain object (the scanner saw its braces), and only its keys
  // leave this boundary — the values stay the tool's own schema's to parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err("the arguments are not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("the arguments are not a JSON object");
  }
  const keys: Record<string, string> = {};
  for (const key of Object.keys(parsed)) keys[key] = key;
  return ok(keys);
}

type Scan = { readonly kind: "ok" } | { readonly kind: "invalid"; readonly reason: string };

const NOT_JSON: Scan = { kind: "invalid", reason: "the arguments are not JSON" };
const REPEATED: Scan = { kind: "invalid", reason: "the arguments repeat a key" };
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.(?:[0-9]+))?(?:[eE][+-]?(?:[0-9]+))?/u;

/**
 * Walk JSON text and refuse a repeated key in any object.
 *
 * @remarks
 * Hand-written because `JSON.parse` does not report duplicates. A string token is skipped by finding
 * its closing quote (a backslash escapes the character after it), so a colon or a brace inside a value
 * is never read as structure; an object's keys are decoded so they compare as the object would see
 * them.
 */
function scanJson(raw: string): Scan {
  let at = 0;

  const skipWhitespace = (): void => {
    while (at < raw.length && WHITESPACE.has(raw[at] ?? "")) at += 1;
  };

  /** Skip one string starting at `at`; false when the text ends before its closing quote. */
  const stringToken = (): boolean => {
    at += 1;
    while (at < raw.length) {
      const character = raw[at];
      if (character === "\\") {
        at += 2;
        continue;
      }
      at += 1;
      if (character === '"') return true;
    }
    return false;
  };

  const literal = (word: string): Scan | undefined => {
    if (!raw.startsWith(word, at)) return NOT_JSON;
    at += word.length;
    return undefined;
  };

  const value = (): Scan | undefined => {
    skipWhitespace();
    const character = raw[at];
    if (character === undefined) return NOT_JSON;
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') return stringToken() ? undefined : NOT_JSON;
    if (character === "t") return literal("true");
    if (character === "f") return literal("false");
    if (character === "n") return literal("null");
    const match = NUMBER.exec(raw.slice(at));
    if (match === null) return NOT_JSON;
    at += match[0].length;
    return undefined;
  };

  const array = (): Scan | undefined => {
    at += 1;
    skipWhitespace();
    if (raw[at] === "]") {
      at += 1;
      return undefined;
    }
    for (;;) {
      const item = value();
      if (item !== undefined) return item;
      skipWhitespace();
      if (raw[at] === ",") {
        at += 1;
        continue;
      }
      if (raw[at] === "]") {
        at += 1;
        return undefined;
      }
      return NOT_JSON;
    }
  };

  const object = (): Scan | undefined => {
    at += 1;
    const keys = new Set<string>();
    skipWhitespace();
    if (raw[at] === "}") {
      at += 1;
      return undefined;
    }
    for (;;) {
      skipWhitespace();
      if (raw[at] !== '"') return NOT_JSON;
      const start = at;
      if (!stringToken()) return NOT_JSON;
      let token: unknown;
      try {
        token = JSON.parse(raw.slice(start, at));
      } catch {
        return NOT_JSON;
      }
      const key = v.safeParse(v.string(), token);
      if (!key.success) return NOT_JSON;
      if (keys.has(key.output)) return REPEATED;
      keys.add(key.output);
      skipWhitespace();
      if (raw[at] !== ":") return NOT_JSON;
      at += 1;
      const member = value();
      if (member !== undefined) return member;
      skipWhitespace();
      if (raw[at] === ",") {
        at += 1;
        continue;
      }
      if (raw[at] === "}") {
        at += 1;
        return undefined;
      }
      return NOT_JSON;
    }
  };

  const refusal = value();
  if (refusal !== undefined) return refusal;
  skipWhitespace();
  if (at !== raw.length) return NOT_JSON;
  return { kind: "ok" };
}

/**
 * Normalize the `path` of a filesystem tool and refuse one that leaves the workspace.
 *
 * @param path - The path as the model wrote it.
 * @param env - The environment the tool resolves paths in; undefined skips the symlink check.
 * @param context - The call's context.
 * @returns The normalized path, or the reason it is refused.
 *
 * @remarks
 * The contract's own rule decides the spelling: POSIX and relative, no `..` segment, no absolute form,
 * no backslash, no NUL, no glob (`normalizePath`). That does not see a symlink — `link/secret` is a
 * normal path whatever `link` points at — so the path is also canonicalized by the environment and
 * must still be the root or below it, which refuses a link that leaves the root the same way (0054 /
 * 0194). A path the environment cannot decide is refused too: "cannot tell" is not "inside" (fail
 * closed).
 */
export async function normalizeToolPath(
  path: string,
  env: ExecutionEnv | undefined,
  context: Context,
): Promise<Result<string, string>> {
  const normalized = normalizePath(path);
  if (normalized.kind === "unsupported") {
    return err("the path cannot be used: " + normalized.reason);
  }
  if (env === undefined) return ok(normalized.value);
  const root = await env.canonicalPath(env.cwd, context);
  if (!root.ok) return err("the workspace root cannot be resolved");
  const target = await canonicalForWrite(env, joinPath(root.value, normalized.value), context);
  if (!target.ok) return target;
  const base = stripTrailingSlash(root.value);
  if (target.value === base || target.value.startsWith(base + "/")) return ok(normalized.value);
  return err("the path is outside the workspace root");
}

function joinPath(base: string, relative: string): string {
  if (relative === ".") return base;
  return stripTrailingSlash(base) + "/" + relative;
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The canonical absolute path, resolving the deepest existing ancestor when the tail is absent.
 *
 * @remarks
 * A write target often does not exist yet; its parent does, and that parent is where a symlink would
 * redirect it, so the answer is the canonical parent plus the missing names.
 */
async function canonicalForWrite(
  env: ExecutionEnv,
  absolute: string,
  context: Context,
): Promise<Result<string, string>> {
  const canonical = await env.canonicalPath(absolute, context);
  if (canonical.ok) return ok(canonical.value);
  if (canonical.error.code !== "not_found") return err("the path cannot be resolved");
  const index = absolute.lastIndexOf("/");
  if (index <= 0) return err("the path cannot be resolved");
  const parent = await canonicalForWrite(env, absolute.slice(0, index), context);
  return parent.ok
    ? ok(stripTrailingSlash(parent.value) + "/" + absolute.slice(index + 1))
    : parent;
}

/**
 * What the audit sink receives: one event, appended before the call runs or before its result returns.
 *
 * @remarks
 * The event is the contract's, except for a refused call's row, which has no hashes (see
 * {@link AuditRow}); the contract's type is claimed where the row is handed to the sink.
 */
export type AuditSink = (event: AuditEvent) => Promise<void>;

/** Where audit events say they came from, and which run the row's call belongs to. */
export interface AuditIdentity {
  /** The workspace (and its Session object). */
  readonly workspaceId: string;
  /**
   * The session the audit rows are recorded under (the Session object's name).
   *
   * @remarks
   * This is the **workspace's** Session, not the conversation: it has been the row's `sessionId`
   * since the audit chain landed. The conversation is {@link conversationId}.
   */
  readonly sessionId: string;
  /**
   * The conversation whose run the call runs in; it is the run a grant is bound to.
   *
   * @remarks
   * A tool call always belongs to one conversation, and a run is that conversation's turn. The
   * granted path asks for the run's grant and relays its call **as this id**, and the Session
   * object revokes that run's grants when the run's abort reaches it. A wiring that has no
   * conversation (a caller that audits without one) leaves it out, and its calls take no granted
   * path.
   */
  readonly conversationId?: string | undefined;
  /** The event id for one event; the caller mints it (a UUID in the app, a counter in a test). */
  readonly eventId: () => string;
}

/** The sinks one call reports to. */
export interface CallSinks {
  /** Tool observations; not awaited. */
  readonly onEvent?: AgentEventSink | undefined;
  /** The contract's audit; awaited before the run and before the result returns. */
  readonly audit?: AuditSink | undefined;
  /** What `audit` names; required when `audit` is given. */
  readonly auditIdentity?: AuditIdentity | undefined;
}

/**
 * What one call is recorded as, whatever was parsed from it.
 *
 * @remarks
 * A refused call may have no parsed arguments at all, so its rows are made of these and the call's
 * identity, never of the arguments.
 */
export interface CallRecord {
  readonly identity: ToolIdentity;
  /** The name the model used; the same as `identity.definition.toolId`. */
  readonly name: string;
  readonly callId: string;
  readonly sinks: CallSinks;
}

/**
 * The fields of one audit row before its event and its decision.
 *
 * @remarks
 * The contract's `AuditEventBase` requires `callHash` and `argsHash`; a refused call has neither,
 * because it never became a call the contract can name (`argsHash` hashes arguments it does not
 * have). This row leaves them out for a refusal and adds them for a call that was admitted.
 */
type AuditRow = Omit<AuditEventBase, "callHash" | "argsHash"> & {
  readonly callHash?: string | undefined;
  readonly argsHash?: string | undefined;
};

/** What one call is checked against: its tool, the call, where it runs, and where it is recorded. */
export interface ToolCallSpec {
  readonly identity: ToolIdentity;
  readonly callId: string;
  readonly env: ExecutionEnv | undefined;
  readonly context: Context;
  readonly sinks: CallSinks;
}

/** The tool's own arguments, as its schema parsed them from a value of unknown shape. */
type ToolParse =
  | {
      readonly ok: true;
      readonly definition: WorkspaceToolDefinition;
      readonly args: ToolArguments;
    }
  | { readonly ok: false; readonly refusal: CapabilityRefusal };

/**
 * Parse one tool's arguments with that tool's own schema.
 *
 * @param definition - The tool, whose schema decides the shape.
 * @param raw - The model's arguments: an object pi-durable validated, or the value it handed a hook.
 * @returns The parsed arguments, or the refusal to read.
 *
 * @remarks
 * This is the **only** place the model's arguments become a domain value: three schemas, three shapes,
 * and nothing outside them. An unknown key, a missing one, or an ill-typed one is refused here (a
 * `strictObject`), before any path is normalized or any hash is computed.
 */
/* oxlint-disable anti-slop/no-unknown-parameters --
   `parseToolArguments` and `admitCall` are the parse boundaries of this module's arguments: the model's
   arguments are untrusted JSON until `definition.schema` accepts them here, and a refusal is a value. */
function parseToolArguments(definition: WorkspaceToolDefinition, raw: unknown): ToolParse {
  const parsed = v.safeParse(definition.schema, raw);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: refusalOf(
        phase0Deny(
          INVALID_ARGUMENTS,
          "the arguments are not the shape " +
            definition.toolId +
            " declares: " +
            (parsed.issues[0]?.message ?? "invalid"),
        ),
      ),
    };
  }
  // SAFETY: each definition's schema produces one of the three argument shapes; a bash call gets its
  // envelope in `namedArguments` before the call is hashed or run.
  return { ok: true, definition, args: parsed.output as ToolArguments };
}

/** A call that cleared the checks: the contract's call, the arguments the tool will run, and its decision. */
interface AdmittedCall {
  readonly call: CallIdentity;
  readonly args: ToolArguments;
  readonly decision: PolicyDecision;
}

/** What admitting a call produced: the admitted call, or the refusal to hand back as an error result. */
export type Admission =
  | { readonly ok: true; readonly admitted: AdmittedCall }
  | {
      readonly ok: false;
      readonly refusal: CapabilityRefusal;
      readonly decision: PolicyDecision;
      /** The call's identity, when its arguments could be hashed at all. */
      readonly identity: CallIdentity | undefined;
    };

/**
 * Admit one call: parse, name the arguments, hash, decide, and **await the audit `tool.call`**.
 *
 * @param spec - The tool, the call, the environment, and the sinks.
 * @param rawArgs - The arguments the tool will run: what the model wrote, as pi-durable validated it.
 * @returns The admitted call (the tool now runs), or the refusal (it does not).
 *
 * @throws Whatever the audit sink rejects with: a call whose `tool.call` could not be appended does not
 * run and has no result (`docs/capability.md` §8, fail closed). The sink is awaited and has no timeout:
 * an append that hangs holds the call, because a dropped row must not look like a call that never
 * happened.
 *
 * @remarks
 * A refusal is recorded too — the `tool.call` this function writes, and a `tool.result` whose decision
 * denies it — so a refused call leaves the same pair of rows a run call does. The call is hashed over
 * the arguments that will run (a normalized path, bash's envelope); a spelling or a value the contract
 * cannot canonicalize has no call to hash, and its rows name the decision instead.
 */
export async function admitCall(
  spec: ToolCallSpec,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the harness's arguments are untrusted
  // until `parseToolArguments` (called below) accepts them; a refusal is recorded, not thrown.
  rawArgs: unknown,
): Promise<Admission> {
  const record: CallRecord = {
    identity: spec.identity,
    name: spec.identity.definition.toolId,
    callId: spec.callId,
    sinks: spec.sinks,
  };
  const parsed = parseToolArguments(spec.identity.definition, rawArgs);
  let refusal: CapabilityRefusal | null = parsed.ok ? null : parsed.refusal;
  // 1. The arguments as the call names them: bash's envelope added, a filesystem path's spelling
  //    normalized, before the call is hashed.
  let args: ToolArguments | undefined;
  if (parsed.ok) {
    const named = namedArguments(parsed.args);
    if (named.ok) args = named.value;
    else refusal = named.error;
  }
  // 2. A filesystem tool's resolved path must still be inside the root (a symlink can leave it).
  if (args !== undefined && !isBashArguments(args)) {
    const contained = await normalizeToolPath(args.path, spec.env, spec.context);
    if (contained.ok) args = withPath(args, contained.value);
    else refusal = refusalOf(phase0Deny("path_outside_root", contained.error));
  }
  // 3. The call's identity: a value with no canonical form is unsupported, and stays unhashed.
  let call: CallIdentity | undefined;
  if (args !== undefined) {
    try {
      call = await callIdentity(spec.identity, spec.callId, args);
    } catch (error) {
      if (!(error instanceof UnsupportedFormatError)) throw error;
      refusal = refusalOf(
        phase0Deny(
          "unsupported",
          error.message + ": " + spec.identity.definition.toolId + " takes integers and text only",
        ),
      );
    }
  }
  const decision: PolicyDecision =
    refusal === null ? phase0Allow() : phase0Deny(refusal.code, refusal.message);
  await appendEvent(record, call, decision, "tool.call", { ok: false, durationMs: 0 });
  if (refusal === null && args !== undefined && call !== undefined) {
    return { ok: true, admitted: { call, args, decision } };
  }
  // The refusal's `tool.result` is written by `afterTool`, which is where every call's result is
  // recorded: one `tool.call` and one `tool.result` per call, whichever way it settled.
  const rejected: Admission = {
    ok: false,
    refusal: refusal ?? refusalOf(phase0Deny("unsupported", "the call has no canonical form")),
    decision,
    identity: call,
  };
  return rejected;
}

/**
 * The arguments a call is named by: bash's envelope added, a filesystem path's spelling normalized.
 *
 * @param args - The tool's parsed arguments.
 * @returns The arguments as a `ToolCall` carries them, or the refusal of a spelling the contract does
 * not accept.
 */
function namedArguments(args: ToolArguments): Result<ToolArguments, CapabilityRefusal> {
  if (args === undefined || args === null) {
    return err(refusalOf(phase0Deny(INVALID_ARGUMENTS, "the arguments are missing")));
  }
  if ("command" in args) {
    // SAFETY: an argument record with a command is a bash call's; the schema produced it.
    const bash: BashArguments = args;
    const named: BashArguments =
      bash.timeoutMs === undefined
        ? { command: bash.command, envelope: PHASE0_EXEC_ENVELOPE }
        : { command: bash.command, timeoutMs: bash.timeoutMs, envelope: PHASE0_EXEC_ENVELOPE };
    return ok(named);
  }
  // SAFETY: the tool's schema said this definition's arguments are a filesystem call's, so the value
  // is one of its two shapes; only their shared `path` (a string both schemas require) is read.
  const file: ReadFileArguments | WriteFileArguments = args;
  const normalized = normalizePath(file.path);
  if (normalized.kind === "unsupported") {
    return err(
      refusalOf(phase0Deny("path_outside_root", "the path cannot be used: " + normalized.reason)),
    );
  }
  return ok(withPath(file, normalized.value));
}

/** A filesystem tool's arguments with the path it will use. */
function withPath(args: ReadFileArguments | WriteFileArguments, path: string): ToolArguments {
  if (isWriteFileArguments(args)) {
    return { path, content: args.content, expectedVersion: args.expectedVersion };
  }
  return { path };
}

/** What a recorded `tool.result` reports: the harness's own verdict, not a second reading of it. */
export interface RecordedOutcome {
  readonly ok: boolean;
  readonly durationMs: number;
}

/**
 * Whether pi-durable's result says the call succeeded, with the same reading the harness uses.
 *
 * @param result - The tool's result, as `afterTool` receives it.
 * @returns false for `isError`, and for a nonzero structured `exitCode` (bash reports a failed command
 * that way without throwing). Both are the harness's own meaning; nothing else is inferred.
 */
export function succeeded(result: ToolExecutionResult): boolean {
  if (result.isError === true) return false;
  const exitCode = exitCodeOf(result.structuredOutput);
  return exitCode === undefined || exitCode === 0;
}

/** The part of bash's structured output that decides success; other tools report none. */
const ExitCodeOutput = v.object({ exitCode: v.number() });

/** The exit code a tool put in its structured output, when it has one. */
function exitCodeOf(output: ToolExecutionResult["structuredOutput"]): number | undefined {
  const parsed = v.safeParse(ExitCodeOutput, output);
  return parsed.success ? parsed.output.exitCode : undefined;
}

/**
 * Record one step of a call: the observation, then the audit row, both from one time.
 *
 * @param record - The call's tool, id, and sinks.
 * @param call - The call's identity, when it has one.
 * @param decision - The decision it runs under.
 * @param event - Which step.
 * @param outcome - Read for `tool.result`; `tool.call` has no outcome.
 *
 * @throws Whatever the audit sink rejects with (fail closed).
 */
export async function appendEvent(
  record: CallRecord,
  call: CallIdentity | undefined,
  decision: PolicyDecision,
  event: "tool.call" | "tool.result",
  outcome: RecordedOutcome,
): Promise<void> {
  const { identity, sinks } = record;
  const at = isoTimestamp(new Date().toISOString());
  const shared = {
    toolId: identity.definition.toolId,
    toolVersion: identity.definition.version,
    callId: record.callId,
    argsHash: call?.digest.argsHash,
    callHash: call?.digest.callHash,
    manifestHash: identity.manifestHash,
  };
  if (event === "tool.call") {
    // The same reading as the audit: a `tool.call` says what is about to run; the decision is known
    // once it settled, so only `tool.result` carries it.
    sinks.onEvent?.({ event, at, tool: record.name, ...shared });
  } else {
    sinks.onEvent?.({
      event,
      at,
      tool: record.name,
      ...shared,
      decision,
      ok: outcome.ok,
      ms: outcome.durationMs,
      durationMs: outcome.durationMs,
    });
  }
  const { audit, auditIdentity } = sinks;
  if (audit === undefined || auditIdentity === undefined) return;
  // A refused call is not a call the contract can name: it has no `argsHash` or `callHash`, and "" is
  // not a hash (`AuditEventSchema` wants 64 hex). The row carries the decision and its code instead;
  // `docs/capability.md` §3 is proposed to say the hashes are absent for a refused call (0220).
  const base: AuditRow = {
    v: 1,
    eventId: auditIdentity.eventId(),
    at,
    workspaceId: auditIdentity.workspaceId,
    sessionId: auditIdentity.sessionId,
    callId: record.callId,
    toolId: shared.toolId,
    toolVersion: shared.toolVersion,
    manifestHash: shared.manifestHash,
    prevHash: null,
    hash: "",
  };
  // An allow that names a grant records which capability the call was decided under: the grant id is
  // the one value that ties this row to the issuance's ledger (0224) and to the machine's counter.
  const granted =
    decision.outcome === "allow" && decision.grantId !== undefined
      ? { grantId: decision.grantId }
      : {};
  const row: AuditRow =
    shared.callHash === undefined || shared.argsHash === undefined
      ? { ...base, ...granted }
      : { ...base, callHash: shared.callHash, argsHash: shared.argsHash, ...granted };
  // The contract puts the decision on `tool.result` only (`AuditEvent`): a `tool.call` says what was
  // about to run, and the decision is judged once the run is over.
  const eventRow =
    event === "tool.call"
      ? toAuditEvent(row, "tool.call")
      : toAuditEvent(row, "tool.result", decision, outcome);
  await audit(asAuditEvent(eventRow));
}

/**
 * A row as one of the contract's audit events.
 *
 * @param row - The fields this module wrote for one step of a call.
 * @param event - Which step it is.
 * @param decision - The decision, for a `tool.result`.
 * @param outcome - The duration, for a `tool.result`.
 * @returns The event the audit sink receives.
 *
 * @remarks
 * The row is what the contract's event is, **with one known gap**: a refused call's row has no
 * `callHash` or `argsHash`, which `AuditEventBase` requires. The gap is stated here rather than
 * papered over with empty strings — `""` is not a hash and the contract's schema refuses it — so the
 * value passed on is an `AuditRow`, and the contract's `AuditEvent` type is claimed only at this
 * one call, where the 0220 proposal (this lane's Result) makes those two members optional. The audit
 * sink's consumer (0222) parses what it stores; until the proposal lands, a refused row is the one
 * it must accept without hashes.
 */
function toAuditEvent(
  row: AuditRow,
  event: "tool.call",
): AuditRow & { readonly event: "tool.call" };
function toAuditEvent(
  row: AuditRow,
  event: "tool.result",
  decision: PolicyDecision,
  outcome: RecordedOutcome,
): AuditRow & {
  readonly event: "tool.result";
  readonly decision: PolicyDecision;
  readonly durationMs: number;
};
function toAuditEvent(
  row: AuditRow,
  event: "tool.call",
): AuditRow & { readonly event: "tool.call" };
function toAuditEvent(
  row: AuditRow,
  event: "tool.result",
  decision: PolicyDecision,
  outcome: RecordedOutcome,
): AuditRow & {
  readonly event: "tool.result";
  readonly decision: PolicyDecision;
  readonly durationMs: number;
};
function toAuditEvent(
  row: AuditRow,
  event: "tool.call" | "tool.result",
  decision?: PolicyDecision,
  outcome?: RecordedOutcome,
):
  | (AuditRow & { readonly event: "tool.call" })
  | (AuditRow & {
      readonly event: "tool.result";
      readonly decision: PolicyDecision;
      readonly durationMs: number;
    }) {
  if (event === "tool.call") {
    // SAFETY: the row has `AuditEventBase`'s fields, and the two hash members only when the call had a
    // hash; the returned type says the hashes are optional, so nothing downstream reads them as present.
    return { ...row, event: "tool.call" };
  }
  return {
    ...row,
    event: "tool.result",
    decision: decision ?? phase0Deny("unsupported", "the call was not decided"),
    durationMs: outcome?.durationMs ?? 0,
  };
}

/**
 * The row as the contract's event type, for the sink.
 *
 * @param row - A row this module built; its hashes are absent only for a refused call.
 * @returns The same value, typed as the contract's event.
 */
function asAuditEvent(row: AuditRow & { readonly event: "tool.call" | "tool.result" }): AuditEvent {
  // SAFETY: the row is the contract's event with the two hash members possibly absent (a refused
  // call), which the 0220 proposal makes optional; this is the single point where the type is
  // claimed, and it is a claim the sink's consumer (0222) knows how to parse.
  return row as AuditEvent;
}

import type { Machine, ProjectId } from "@hns/core";
import { ProjectIdSchema } from "@hns/core";
import { SignedGrantSchema, type SignedGrant } from "@hns/core/capability";
import * as v from "valibot";
import type { GrantRequest } from "../do/session-grants.ts";
import type { GrantRequester } from "../do/grant-ledger.ts";
import type { WorkerEnv } from "../edge/env.ts";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import { principalOf } from "../policy/principals.ts";
import type { PolicyFace } from "./policy/face.ts";
import type { Store } from "@hns/store";

/**
 * The Worker's grant port: `requestGrant`'s production implementation (0224).
 *
 * @remarks
 * This is the **only** place the Worker forwards a grant request, and the only place a signed grant
 * crosses from a Session object back to a caller. It does the five things the object cannot:
 *
 * 1. **read the active policy** from D1 (`PolicyFace.activeDocument`, which ensures revision 1
 *    exists), and take its revision and hash from the store in the same request, so the snapshot's
 *    `revision` and `hash` are one revision's;
 * 2. **check the project and the machine**: the project must exist (a grant for an unknown project
 *    would let a caller name any workspace), and the machine must be enrolled and not revoked;
 * 3. **name the tool's contract**: the manifest of the tool at the version the Worker declares, so
 *    the object can check the caller's hash against a manifest that really exists;
 * 4. **say who asks**, from the verified session's subject, and bind the grant to the run when the
 *    caller gave one;
 * 5. **forward** `POST /rpc/grants` to the session object through the `SESSION` binding.
 *
 * **The signed grant never appears in a log, an event, or an error message.** The request carries
 * the snapshot, the request, the manifests and the requester; none of them is a capability. The
 * answer's `grant` is returned to the resolver and nowhere else.
 */

/** What one `requestGrant` call carries from GraphQL. */
export interface GrantRequestRead {
  readonly projectId: string;
  readonly machineId: string;
  readonly toolId: string;
  /**
   * The contract's tool version; absent means "the version this deployment's tools declare".
   *
   * @remarks
   * The Worker does not know the version: it is a fact of the tool contracts the **agent** builds
   * (`@hns/agent`'s `TOOL_VERSION`), and loading that table here would pull the harness's runtime
   * into the Worker bundle. The version travels back from the session object with a rejection
   * (`tool_version`), and a caller that was refused sends the request again with it: a grant is
   * never issued for a version the Worker guessed.
   */
  readonly toolVersion?: string | undefined;
  readonly maxBytes?: number | undefined;
  /**
   * `manifestHash` of the tool contract the caller is running.
   *
   * @remarks
   * The caller (the agent's tool runtime) knows its manifest; the Worker does not, and building the
   * agent's table here would put the harness's runtime in the Worker bundle. The object checks the
   * hash against the manifest of the version asked for, so an unhashed request is refused.
   */
  readonly manifestHash?: string | undefined;
  /** The conversation whose run asks; a grant bound to it is revoked when the run ends. */
  readonly runId?: string | undefined;
}

/** The successful answer: the signed grant. */
export interface GrantRequestSuccess {
  readonly ok: true;
  readonly grant: SignedGrant;
}

/** The refusal: a code the client branches on and a message a person reads. */
export interface GrantRequestFailure {
  readonly ok: false;
  readonly code: "forbidden" | "invalid_request" | "not_found" | "unavailable";
  readonly message: string;
  /**
   * The tool version to send the request again with, when the object named one.
   *
   * @remarks
   * The Worker does not carry the tool table, so the first request for a tool without a version is
   * answered with this; the caller sends the request again with `toolVersion` (and `manifestHash`)
   * set. The code stays `invalid_request`: the request lacks a fact its caller has.
   */
  readonly toolVersion?: string | undefined;
}

/** The port's answer. */
export type GrantRequestResult = GrantRequestSuccess | GrantRequestFailure;

/** The grant port one GraphQL request uses. */
export interface GrantPort {
  /**
   * Ask the session object for one grant.
   *
   * @param input - The GraphQL input.
   * @param subject - The verified session's subject (a person, or an agent namespace).
   * @returns The signed grant, or the typed refusal.
   * @throws QueryReadError for an outage the resolver turns into `unavailable`.
   *
   * @remarks
   * A refusal the object decided (a disabled tool, a manifest mismatch, a refused algorithm) is
   * `forbidden` or `invalid_request` by its own meaning; an object that does not answer is
   * `unavailable`, and never a grant.
   */
  request(input: GrantRequestRead, subject: string): Promise<GrantRequestResult>;
}

/** The tools a grant may name, as the contract's closed list. */
const ToolIdSchema = v.picklist(["read_file", "write_file", "bash"]);

/** The shape the session object's grant route answers with. */
const GrantAnswerSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), grant: v.unknown() }),
  v.object({
    ok: v.literal(false),
    code: v.optional(v.string()),
    message: v.optional(v.string()),
    /** Present with `tool_version`: the version the object's tool contracts declare. */
    toolVersion: v.optional(v.string()),
  }),
]);

/** What one request needs from the Worker. */
export interface GrantPortOptions {
  readonly env: WorkerEnv;
  readonly requestId: string;
  /** The active policy face (D1); it is what makes a snapshot possible without the object reading D1. */
  readonly policy: PolicyFace;
  /** The enrolled machines, read from D1 (the registry's list). */
  readonly machines: () => Promise<readonly Machine[]>;
  /** The project lookup (D1). */
  readonly project: (projectId: ProjectId) => Promise<import("@hns/core").Project | undefined>;
  /** The store, for the policy's active revision number and hash. */
  readonly store: () => Promise<Store>;
  /** The signal the request's deadline cancels. */
  readonly signal: AbortSignal;
}

/** The refusal the object's code maps to. */
function refusalOf(code: string | undefined, message: string | undefined): GrantRequestResult {
  const text = message ?? "The grant was refused.";
  switch (code) {
    case "tool_disabled":
    case "policy_denied":
      return { ok: false, code: "forbidden", message: text };
    case "manifest_mismatch":
    case "grant_invalid":
    case "grant_algorithm_mismatch":
    case "unsupported":
      return { ok: false, code: "invalid_request", message: text };
    default:
      return { ok: false, code: "unavailable", message: text };
  }
}

/**
 * Build the grant port over one request's Worker environment.
 *
 * @param options - The environment, the policy face, the registry read, the project lookup, the
 * store, and the request's signal.
 * @returns The port.
 */
export function grantPortOver(options: GrantPortOptions): GrantPort {
  return {
    async request(input, subject) {
      const projectId = v.safeParse(ProjectIdSchema, input.projectId);
      if (!projectId.success) {
        return { ok: false, code: "invalid_request", message: "projectId is not a project id." };
      }
      const toolId = v.safeParse(ToolIdSchema, input.toolId);
      if (!toolId.success) {
        return { ok: false, code: "invalid_request", message: "toolId is not a workspace tool." };
      }
      const project = await options.project(projectId.output);
      if (project === undefined) {
        return { ok: false, code: "not_found", message: "No project has this id." };
      }
      const machines = await options.machines();
      const machine = machines.find((candidate) => candidate.id === input.machineId);
      if (machine === undefined || machine.status === "revoked") {
        return {
          ok: false,
          code: "not_found",
          message: "No enrolled machine has this id.",
        };
      }
      const document = await options.policy.activeDocument(projectId.output);
      if (!document.ok) {
        return {
          ok: false,
          code: document.code === "unsupported" ? "invalid_request" : "unavailable",
          message: document.message,
        };
      }
      const store = await options.store();
      const active = await store.policy.active(projectId.output);
      if (active === undefined) {
        throw new Error("the active policy is missing after the face ensured it");
      }
      const principal = principalOf(subject);
      const requestedBy: GrantRequester =
        input.runId === undefined
          ? { kind: principal.kind, id: principal.id }
          : { kind: principal.kind, id: principal.id, runId: input.runId };
      // The tool's contract travels with the request: the Worker holds no copy of the agent's tool
      // table, so the caller (which is the agent's runtime) sends its manifest hash and the byte
      // bound it wants, and the object checks both against the tool contract its tool actually
      // runs. Without a hash there is nothing to check, and the object answers `invalid_request`.
      const request: GrantRequest = {
        workspaceId: projectId.output,
        sessionId: projectId.output,
        machineId: machine.id,
        toolId: toolId.output,
        toolVersion: input.toolVersion ?? "",
        manifestHash: input.manifestHash ?? "",
        maxBytes: input.maxBytes ?? 0,
      };
      const session = options.env.SESSION;
      if (session === undefined) {
        return { ok: false, code: "unavailable", message: "The Session binding is missing." };
      }
      const stub = session.get(session.idFromName(projectId.output));
      const body = JSON.stringify({
        request,
        snapshot: {
          revision: active.revision,
          hash: active.hash,
          document: document.value,
        },
        requestedBy,
      });
      let response: Response;
      try {
        response = await stub.fetch(
          new Request("https://session.internal/rpc/grants", {
            method: "POST",
            headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: options.requestId },
            body,
            signal: options.signal,
          }),
        );
      } catch {
        return { ok: false, code: "unavailable", message: "The Session did not answer." };
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        return { ok: false, code: "unavailable", message: "The Session answered with no grant." };
      }
      const parsed = v.safeParse(GrantAnswerSchema, answer);
      if (!parsed.success) {
        return { ok: false, code: "unavailable", message: "The Session answered with no grant." };
      }
      if (!parsed.output.ok) {
        if (parsed.output.code === "tool_version" && parsed.output.toolVersion !== undefined) {
          // The object names the version its tool contracts declare; the caller sends the request
          // again with it rather than the Worker guessing (the version is the tool contract's fact).
          return {
            ok: false,
            code: "invalid_request",
            message: parsed.output.message ?? "Send the request again with this toolVersion.",
            toolVersion: parsed.output.toolVersion,
          };
        }
        return refusalOf(parsed.output.code, parsed.output.message);
      }
      const grant = v.parse(v.object({ grant: SignedGrantSchema }), {
        grant: v.parse(v.object({ grant: v.unknown() }), parsed.output).grant,
      });
      return { ok: true, grant: grant.grant };
    },
  };
}

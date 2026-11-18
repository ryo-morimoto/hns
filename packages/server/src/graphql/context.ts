import * as v from "valibot";
import type {
  Machine,
  MachineEnrollment,
  MachineRegistration,
  MachineRegistryRefusal,
  Project,
  ProjectId,
  ReviewMirrorFallback,
  ReviewReadSource,
} from "@hns/core";
import type {
  ConversationCursor,
  ConversationListQuery,
  ConversationPage,
  IndexStateRow,
  Store,
  TrailChangeValue,
  TrailCreateInput,
  TrailDecisionCreateInput,
  TrailDecisionValue,
  TrailFindingCreateInput,
  TrailFindingValue,
  TrailGateValue,
  TrailRowValue,
  TrailSessionValue,
  TrailUpdate,
  TrailWriteRefusal,
} from "@hns/store";
import { selectedReviewDiff } from "../review/selected.ts";
import type { ReviewDiff } from "../review/service.ts";
import { R2ReviewSource } from "../review/r2.ts";
import { writeHunk } from "../review/write.ts";
import type { ReviewDiffWriteResult } from "../review/write.ts";
import type { WorkerEnv } from "../edge/env.ts";
import { createRowBudget, type RowBudget } from "../edge/limits.ts";
import type { Session } from "../edge/session.ts";
import { projectFor, storeFor, StoreUnavailableError } from "../edge/store.ts";
import { QueryReadError } from "./failures.ts";
import { probeAll } from "../machines/probe.ts";
import { policyFaceOver, type PolicyFace } from "./policy/face.ts";
import { grantPortOver, type GrantPort } from "./grants.ts";
import { conversationPortOver } from "./send-message-port.ts";
import { NO_OFFICE_PORT } from "./office-port.ts";
import type { OfficePort } from "./office.ts";
export type { OfficePort };

import { grantInternalToken } from "../do/grant-subject.ts";

/** The send port a resolver calls (0270n); its production implementation is `send-message-port.ts`. */
export interface MessagePort {
  readonly send: (
    input: { readonly conversationId: string; readonly text: string },
    subject: string,
  ) => Promise<import("./send-message-port.ts").SendMessageResult>;
}

/**
 * The grant route token one isolate sends, derived once from the session secret.
 *
 * @remarks
 * The derivation is a SHA-256 of a fixed prefix and the secret; `createContext` is synchronous, so
 * the port is given the promise and awaits it on the one path that needs it.
 */
const GRANT_TOKENS = new Map<string, Promise<string | undefined>>();

/**
 * The token for the environment's session secret.
 *
 * @param env - The Worker environment.
 * @returns The token, or undefined when the environment has no secret.
 */
function grantTokenFor(env: WorkerEnv): Promise<string | undefined> {
  const secret = env.HNS_SESSION_SECRET;
  if (secret === undefined) return Promise.resolve(undefined);
  const cached = GRANT_TOKENS.get(secret);
  if (cached !== undefined) return cached;
  const token = grantInternalToken(secret);
  GRANT_TOKENS.set(secret, token);
  return token;
}

/** A grant request as GraphQL carries it (0224); the port's input, re-exported for the mutation. */
export type { GrantRequestRead, GrantRequestResult } from "./grants.ts";

/**
 * The reads one GraphQL request performs.
 *
 * @remarks
 * A port per Query field, so each resolver names its source and tests replace one read without
 * a D1 database or a Durable Object.
 */
export interface GraphQLReads {
  readonly projects: () => Promise<readonly Project[]>;
  /**
   * The project with this id, or undefined.
   *
   * @remarks
   * The existence check runs before any other read names a project, so a client cannot make a
   * face address a Durable Object that D1 does not know.
   */
  readonly project: (projectId: ProjectId) => Promise<Project | undefined>;
  /**
   * The Trails of one project, or of every project when `projectId` is undefined, newest first.
   *
   * @remarks
   * The store answers a list that may hold a `corrupt_row` refusal (a row this build cannot read
   * is refused, not dropped), so the port keeps that union rather than pretending it is a clean
   * list; the resolver turns it into a typed failure.
   */
  readonly trails: (
    projectId?: ProjectId | undefined,
  ) => Promise<readonly (TrailRowValue | TrailWriteRefusal)[]>;
  /** The Trail with this id, or the store's `not_found` / `corrupt_row` refusal. */
  readonly trail: (id: string) => Promise<TrailRowValue | TrailWriteRefusal>;
  /**
   * The Changes of a Trail, oldest first.
   *
   * @remarks
   * The store answers a Change it cannot parse as a `corrupt_row` refusal in the list, like every
   * other read of that repository, so the port keeps the union; the resolver turns it into a typed
   * failure.
   */
  readonly trailChanges: (
    trailId: string,
  ) => Promise<readonly (TrailChangeValue | TrailWriteRefusal)[]>;
  /**
   * The sessions a Trail is linked to, oldest first (0232).
   *
   * @remarks
   * Same shape as `trailChanges`: the store answers a row it cannot parse as a `corrupt_row`
   * refusal in the list, and the resolver turns that into a typed failure.
   */
  readonly trailSessions: (
    trailId: string,
  ) => Promise<readonly (TrailSessionValue | TrailWriteRefusal)[]>;
  /** The findings on a Trail, newest first; the same `corrupt_row` rule as {@link trailChanges}. */
  readonly trailFindings: (
    trailId: string,
  ) => Promise<readonly (TrailFindingValue | TrailWriteRefusal)[]>;
  /** The decisions on a Trail, newest first; the same `corrupt_row` rule as {@link trailChanges}. */
  readonly trailDecisions: (
    trailId: string,
  ) => Promise<readonly (TrailDecisionValue | TrailWriteRefusal)[]>;
  /**
   * The gate evaluations recorded on a Trail, newest first.
   *
   * @remarks
   * The **evidence** a gate left, not the gate's state now: `Trail.gates` computes that from the
   * head, the findings, and the decisions, and this list is what it was before.
   */
  readonly trailGates: (
    trailId: string,
  ) => Promise<readonly (TrailGateValue | TrailWriteRefusal)[]>;
  /**
   * The latest Change of a Trail, or undefined when it has none: the head its review is about.
   *
   * @remarks
   * The gates and an approval both address this Change (C2 / C3). A trailing `corrupt_row` in
   * `trailChanges` already fails the read of the list, so this port answers the row or nothing; a
   * corrupt row is reported by the list.
   */
  readonly trailHead: (trailId: string) => Promise<TrailChangeValue | undefined>;
  /**
   * The base commit a Trail's review is compared against, or undefined when it has no Change.
   *
   * @remarks
   * The first commit the Trail was taken from. The freshness gate compares the Change's
   * `baseCommit` with it: equal is "the base did not move".
   */
  readonly trailBase: (trailId: string) => Promise<string | undefined>;
  /**
   * The diff between two commits, and where it was read from (C1 / 0248).
   *
   * @returns The diff with its source and any mirror fallback, or a typed failure the review face
   * shows.
   *
   * @remarks
   * The diff engine (`review/service.ts`) is the one the editor has (0009 / 0011), and it reads a
   * `ReviewSource`. **Which source is the server's decision** (`review/selected.ts`): Artifacts
   * first, then the R2 checkpoint packs (D106), and the machine as the fallback no route can read
   * yet. The port answers the source it read, so the screen shows the server's choice instead of
   * making one; the workspace of the Change is part of the question because the Artifacts
   * repository is the workspace's.
   */
  readonly reviewDiff: (change: ReviewDiffRead) => Promise<ReviewDiffWithSourceReadResult>;
  /**
   * One page of the D1 conversation index, scoped to the project.
   *
   * @remarks
   * The index is a copy: a conversation the Session has not written yet is missing here, and
   * its detail still comes from the object. The read never addresses a Durable Object.
   */
  readonly conversations: (
    projectId: ProjectId,
    query: ConversationReadQuery,
  ) => Promise<ConversationPage>;
  /** The project's index backlog and last failure, one row per workspace. */
  readonly indexState: (projectId: ProjectId) => Promise<IndexStateRow>;
  /**
   * The registered machines, read from D1 (0148).
   *
   * @remarks
   * A list is read from D1 directly (D049). The port is also where the reachability probe is
   * throttled: the production port probes every non-revoked machine before it answers, and the
   * registry's delayed write is what keeps a list read from amplifying writes (D087 U-03).
   */
  readonly machines: () => Promise<readonly Machine[]>;
}

/** What one conversation list read asks the index for. */
export interface ConversationReadQuery {
  /** Maximum rows; the resolver has already checked 1..maxRowsPerList. */
  readonly first: number;
  /** Return only rows after this keyset position. */
  readonly after?: ConversationCursor | undefined;
  /** Title substring; LIKE metacharacters match themselves. */
  readonly q?: string | undefined;
}

/** What a resolver asks the store to write. */
interface CreateProjectInput {
  readonly name: string;
  /** Already canonical; the resolver refuses an empty or non-canonical root first. */
  readonly workspaceRoot: string;
}

/** What a resolver asks the store to create: the store's own input, named once. */
type CreateTrailWrite = TrailCreateInput;

/** What a resolver asks the store to change: the store's own patch, named once. */
type UpdateTrailWrite = TrailUpdate;

/**
 * The refusals an enrollment can answer with.
 *
 * @remarks
 * The registry's own closed vocabulary, minus `not_found` (an enrollment has no id to miss).
 */
export type MachineEnrollRefusal = MachineRegistryRefusal;

/**
 * The writes one GraphQL request performs.
 *
 * @remarks
 * Same shape as {@link GraphQLReads}: one port per mutation field, replaced in tests so the
 * resolver contract is proven without D1. A port throws `QueryReadError` for an expected outage;
 * the resolver turns that into a `MutationFailure` and never into a payload.
 */
export interface GraphQLWrites {
  readonly createProject: (input: CreateProjectInput) => Promise<Project>;
  /**
   * Enroll a machine, or replace its key as a reimage (0148).
   *
   * @remarks
   * The actor is the session subject that asked; the registry records it in the event and never
   * returns it. The result is the registry's own union: `enrolled` / `reimaged` / a refusal, so
   * the resolver maps one closed vocabulary to one union member.
   */
  readonly enrollMachine: (
    enrollment: MachineEnrollment,
    actor: string,
  ) => Promise<MachineRegistration | MachineEnrollRefusal>;
  /**
   * Revoke a machine; undefined when no row has this id (0148).
   *
   * @remarks
   * Revocation is immediate: the registry stops returning the device key for the machine, so its
   * next signed request is refused.
   */
  readonly revokeMachine: (id: string, actor: string) => Promise<Machine | undefined>;
  /**
   * Create a Trail in a project (D104).
   *
   * @remarks
   * The Trail starts `draft`: the store owns the state machine, so no resolver can create a Trail
   * in a state the transition table would not have reached. A refusal is a value, not an
   * exception.
   */
  readonly createTrail: (input: CreateTrailWrite) => Promise<TrailRowValue | TrailWriteRefusal>;
  /**
   * Change a Trail's title, description, acceptance, kind, or priority.
   *
   * @returns The updated Trail, the store's refusal, or undefined when no row has the id.
   */
  readonly updateTrail: (
    id: string,
    patch: UpdateTrailWrite,
  ) => Promise<TrailRowValue | TrailWriteRefusal | undefined>;
  /**
   * Record a Decision on a Trail (0232): an approval, a change request, or a rejection.
   *
   * @remarks
   * The actor is the resolver's to pass (it takes the session's subject); the store refuses an
   * approval whose head the Trail does not have, so the C2 rule is checked in the layer that
   * persists it as well as in the resolver that reads it.
   */
  readonly addTrailDecision: (
    trailId: string,
    input: TrailDecisionCreateInput,
  ) => Promise<TrailDecisionValue | TrailWriteRefusal>;
  /** Raise a Finding on a Trail; the resolver checks the vocabularies before this port runs. */
  readonly addTrailFinding: (
    trailId: string,
    input: TrailFindingCreateInput,
  ) => Promise<TrailFindingValue | TrailWriteRefusal>;
}

/**
 * What a diff read asks for: the Change's own pair, and the workspace whose mirror is read.
 *
 * @remarks
 * The pair is the Change's (`base_commit` / `head_commit`), never a client's. `workspaceId` names
 * the workspace the Change's commits were checked in, which is what names the Artifacts repository
 * (D106: one repository per workspace); a Change that names none is read from the checkpoint store
 * only, which is the same answer as a workspace with no mirror.
 */
export interface ReviewDiffRead {
  readonly workspaceId: string | undefined;
  readonly base: string;
  readonly head: string;
}

/**
 * The answer of one diff read, with the store it came from (0248).
 *
 * @remarks
 * `source` is the store that produced the diff and `mirror` the commits Artifacts did not hold, so
 * a screen can say "read from the checkpoint store because the mirror failed" instead of guessing.
 * `fallback` is the server's own sentence for that, so every client shows the same words.
 */
export type ReviewDiffWithSourceReadResult =
  | {
      readonly ok: true;
      readonly diff: ReviewDiff;
      readonly source: ReviewReadSource;
      readonly mirror: readonly ReviewMirrorFallback[];
      readonly fallback: string | null;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "not_found" | "too_large" | "unauthorized" | "unavailable";
      readonly message: string;
    };

/** What a hunk action asks for. */
export interface ReviewHunkWrite {
  /** The Change the hunk belongs to (base..head), decoded from its global id. */
  readonly changeId: string;
  /** The base and head the caller read; a Change that moved is refused. */
  readonly base: string;
  readonly head: string;
  /** The path the hunk is in; must be inside the workspace and not binary. */
  readonly path: string;
  /** The line the hunk starts at on the head side (0 for a deletion-only hunk at the top). */
  readonly headStart: number;
  /** The version of the file the caller saw, or `absent`. */
  readonly expectedVersion: string;
  /** The actor the file write is recorded under. */
  readonly actor: string;
}

/** The ports the review face writes through. */
export interface GraphQLReviewWrites {
  /**
   * Write the bytes `action` produces from one hunk, if the file is still at `expectedVersion`.
   *
   * @returns The outcome, and the diff re-read afterwards when the write was applied.
   *
   * @remarks
   * The three actions differ only in which bytes they produce:
   *
   * - **keep** writes the head bytes (the hunk stays as it is);
   * - **undo** writes the base bytes (the hunk is reverted to the base);
   * - **apply** writes the head bytes for a hunk the base does not have, and the base bytes for a
   *   hunk the head does not have (a resolution taken on the screen).
   *
   * Every one of them goes through `applyVersionedWrite`, so a file that moved since the caller
   * read it is `conflict` and nothing is written.
   */
  readonly hunk: (
    action: "keep" | "undo" | "apply",
    input: ReviewHunkWrite,
  ) => Promise<ReviewDiffWriteResult>;
}

/** What one request carries into its resolvers. */
export interface GraphQLContext {
  /** The edge's correlation id; logged, never returned. */
  readonly requestId: string;
  /**
   * The verified caller.
   *
   * @remarks
   * The edge has proven only that the cookie is a valid session. A mutation resolver still
   * authorizes its own target (owner) before it writes.
   */
  readonly session: Session;
  readonly reads: GraphQLReads;
  readonly writes: GraphQLWrites;
  /**
   * The review face's writes (0232): a hunk's keep / undo / apply, each a versioned write.
   *
   * @remarks
   * A port of its own rather than a {@link GraphQLWrites} member because it writes **files**, not
   * rows: it is the Workspace's `applyVersionedWrite` behind a seam, and a test replaces it with
   * one over a temporary directory.
   */
  readonly review: GraphQLReviewWrites;
  /**
   * The grant port: `requestGrant` asks a session object for one capability grant (0224).
   *
   * @remarks
   * The production port reads the active policy from D1, checks the project and the machine, and
   * forwards the request to the session object. A test replaces it with a fake that records what it
   * was asked, so the resolver's own checks are testable without a Durable Object.
   */
  readonly grants: GrantPort;
  /**
   * The send port: `sendMessage` puts a turn into a conversation, with the project's active policy
   * snapshot (0270n).
   *
   * @remarks
   * The port finds the conversation in D1, reads the active policy of its project, and forwards the
   * send to the conversation's Session object. It is a port so a resolver test needs no D1 and no
   * Durable Object, and so the resolver holds no D1 read of its own.
   */
  readonly messages: MessagePort;
  /**
   * The office face's rows and engine (0237).
   *
   * @remarks
   * A port like the others: production forwards to the workspace's Session object (which owns the
   * preview rows, the alarm that runs them, and the machine wire), and a resolver test replaces
   * it. The two reads and the request are the whole office surface of the GraphQL endpoint.
   */
  readonly office: OfficePort;
  /**
   * The policy service's operations, as the policy fields call them.
   *
   * @remarks
   * One port rather than one per field: the four policy fields are four views of one service, and a
   * port on the context is what lets a unit test replace it. Production builds it with
   * `policyFaceOver` over the request's store; the port opens the store lazily.
   */
  readonly policy: PolicyFace;
  /** The rows this request may still read or write across every resolver. */
  readonly budget: RowBudget;
  /** The most rows one list field may return. */
  readonly maxRowsPerList: number;
}

/** How to build a context; tests pass `reads` and shrink the limits. */
export interface GraphQLContextOptions {
  readonly env: WorkerEnv;
  readonly requestId: string;
  readonly session: Session;
  readonly reads?: Partial<GraphQLReads> | undefined;
  readonly writes?: Partial<GraphQLWrites> | undefined;
  /** Replace the review face's file writes; production builds it over the checkpoint packs. */
  readonly review?: Partial<GraphQLReviewWrites> | undefined;
  /**
   * Replace the policy face; production builds it over the control database.
   *
   * @remarks
   * Required rather than optional with a default, because the default reaches for `env.DB` and a
   * test that forgot to replace it would answer `unavailable` instead of testing the face. The
   * production caller (`handler.ts`) passes undefined explicitly to mean "the default".
   */
  readonly policy: PolicyFace | undefined;
  /** Replace the grant port; production builds it over the request's D1 and the SESSION binding. */
  readonly grants?: GrantPort | undefined;
  /**
   * Replace the office port (0237); production forwards to the workspace's Session object.
   *
   * @remarks
   * A test that asks `documentPreview` or `requestDocumentPreview` without a Durable Object
   * replaces this one port; the resolvers' own checks (the workspace, the union, the failure)
   * are what it then observes.
   */
  readonly office?: OfficePort | undefined;
  /**
   * Replace the send port; production builds it over the request's D1 and the SESSION binding.
   *
   * @remarks
   * A test that sends through the GraphQL face without a Durable Object replaces this one port, and
   * the resolver's own checks (the global id's type, the text bound, the budget) are what it then
   * observes.
   */
  readonly messages?: MessagePort | undefined;
  /**
   * The token the session object expects on the grant route, derived from `HNS_SESSION_SECRET`.
   *
   * @remarks
   * Production passes what the edge derived once per isolate; a context built without it sends no
   * token, and the object refuses (fail closed). A test that builds a context without a secret is
   * therefore testing a refusal, which is what NB7 makes of a caller it cannot identify.
   */
  readonly grantToken?: string | undefined;
  readonly maxRows: number;
  readonly maxRowsPerList: number;
  /**
   * The request's abort signal, so a reachability probe cannot outlive the request.
   *
   * @remarks
   * Optional: a test that replaced `reads.machines` never probes, and a probe without a signal is
   * bounded by the transport's own 3-second deadline.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Run a store lookup, mapping an expected outage to `unavailable`.
 *
 * @internal
 * @remarks
 * Only `StoreUnavailableError` becomes a union failure. A corrupt row (`ValiError`) is a
 * defect and is rethrown, so the request answers 500 instead of a retryable outage.
 */
async function storeFailure<T>(requestId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      console.error("graphql: store open failed", requestId, error.name);
      throw new QueryReadError("unavailable", error.message);
    }
    throw error;
  }
}

/** Open the store, mapping a missing binding or a failed open to `unavailable`. */
async function storeWith(env: WorkerEnv, requestId: string): Promise<Store> {
  return await storeFailure(requestId, () => storeFor(env));
}

/**
 * Run one store call, mapping an expected outage to `unavailable`.
 *
 * @internal
 * @remarks
 * A corrupt row (`ValiError`) is not an outage: it means the stored data disagrees with the
 * model, so it stays an unexpected failure and becomes a 500. A failed write is not reported as
 * a completed one.
 */
async function storeCall<T>(
  env: WorkerEnv,
  requestId: string,
  action: "read" | "write",
  work: (store: Store) => Promise<T>,
): Promise<T> {
  const store = await storeWith(env, requestId);
  try {
    return await work(store);
  } catch (error) {
    if (error instanceof v.ValiError) throw error;
    console.error(
      "graphql: store " + action + " failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    throw new QueryReadError("unavailable", "The database " + action + " failed.");
  }
}

/**
 * Turn one resolver read into the store's query.
 *
 * @internal
 * @remarks
 * The optional fields are added one by one: `exactOptionalPropertyTypes` means a present key
 * cannot hold `undefined`, so a spread of a conditional object would widen the type.
 */
function pageQuery(projectId: ProjectId, query: ConversationReadQuery): ConversationListQuery {
  if (query.after === undefined) {
    return query.q === undefined
      ? { projectId, limit: query.first }
      : { projectId, limit: query.first, q: query.q };
  }
  return query.q === undefined
    ? { projectId, limit: query.first, after: query.after }
    : { projectId, limit: query.first, after: query.after, q: query.q };
}

/**
 * The production machine list: D1, then a throttled reachability probe (0148 / D087 U-03).
 *
 * @internal
 * @remarks
 * The list is read from D1 first, so the caller sees every machine even when a probe cannot reach
 * one. The probes then run **concurrently** with the 3-second transport deadline; each records its
 * observation through the registry's throttled write. When no control-plane key is configured the
 * probes are skipped entirely: an unconfigured deployment must not turn every machine `offline`
 * by probing with a key it does not have. A probe never fails the read.
 */
async function machineListRead(
  env: WorkerEnv,
  requestId: string,
  signal: AbortSignal | undefined,
): Promise<readonly Machine[]> {
  const machines = await storeCall(env, requestId, "read", (store) => store.machines.list());
  const controlPlaneKey = env.HNS_CONTROL_PLANE_KEY;
  if (controlPlaneKey === undefined || controlPlaneKey.length === 0) return machines;
  const store = await storeWith(env, requestId);
  try {
    await probeAll(machines, {
      machines: store.machines,
      controlPlaneKey,
      requestId,
      signal,
    });
    return await store.machines.list();
  } catch (error) {
    // A probe is an observation; a failure to store one must not hide the list.
    console.error(
      "graphql: machine probe failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    return machines;
  } finally {
    await store.close();
  }
}

/** The production reads: D1 for projects, trails, and the conversation index. */
function defaultReads(
  env: WorkerEnv,
  requestId: string,
  signal?: AbortSignal | undefined,
): GraphQLReads {
  return {
    projects: () => storeCall(env, requestId, "read", (store) => store.projects.list()),
    project: (projectId) => storeFailure(requestId, () => projectFor(env, projectId)),
    trails: (projectId) =>
      storeCall(env, requestId, "read", (store) => store.trails.list(projectId)),
    trail: (id) => storeCall(env, requestId, "read", (store) => store.trails.get(id)),
    trailChanges: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.listChanges(trailId)),
    trailSessions: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.listSessions(trailId)),
    trailFindings: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.listFindings(trailId)),
    trailDecisions: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.listDecisions(trailId)),
    trailGates: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.listGates(trailId)),
    trailHead: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.headChange(trailId)),
    trailBase: (trailId) =>
      storeCall(env, requestId, "read", (store) => store.trails.baseCommit(trailId)),
    reviewDiff: (read) => diffRead(env, requestId, read),
    conversations: (projectId, query) =>
      storeCall(env, requestId, "read", (store) =>
        store.conversations.page(pageQuery(projectId, query)),
      ),
    indexState: (projectId) =>
      storeCall(env, requestId, "read", (store) => store.indexState.read(projectId)),
    machines: () => machineListRead(env, requestId, signal),
  };
}

/**
 * The production policy face: the policy service over the request's control database.
 *
 * @internal
 * @remarks
 * The port opens the policy lazily, so a request that never touches a policy field does not pay for
 * `ensure`. `bashSandbox` is `false`: no machine fact on the project row says a workspace has a
 * sandbox yet (the machine's capability has not reached the session), and `false` is the fail
 * closed default — the baseline then omits `bash` rather than granting a process nobody can
 * sandbox. A store that cannot be opened is `unavailable`, like every other read on this face.
 */
function defaultPolicy(env: WorkerEnv, requestId: string): PolicyFace {
  let opened: PolicyFace | undefined;
  const open = async (): Promise<PolicyFace> => {
    if (opened !== undefined) return opened;
    const store = await storeWith(env, requestId);
    if (opened === undefined) opened = policyFaceOver(store, { bashSandbox: false });
    return opened;
  };
  return {
    activeDocument: (workspaceId) =>
      storeFailure(requestId, async () => (await open()).activeDocument(workspaceId)),
    revisions: (workspaceId) =>
      storeFailure(requestId, async () => (await open()).revisions(workspaceId)),
    proposals: (workspaceId, status) =>
      storeFailure(requestId, async () => (await open()).proposals(workspaceId, status)),
    propose: (actor, input) =>
      storeFailure(requestId, async () => (await open()).propose(actor, input)),
    decide: (actor, input) =>
      storeFailure(requestId, async () => (await open()).decide(actor, input)),
  };
}

/** The production writes: D1 for the project and machine tables. */
function defaultWrites(env: WorkerEnv, requestId: string): GraphQLWrites {
  return {
    createProject: (input) =>
      storeCall(env, requestId, "write", (store) =>
        store.projects.create(input.name, input.workspaceRoot),
      ),
    enrollMachine: (enrollment, actor) =>
      storeCall(env, requestId, "write", (store) => store.machines.enroll(enrollment, actor)),
    revokeMachine: (id, actor) =>
      storeCall(env, requestId, "write", (store) => store.machines.revoke(id, actor)),
    createTrail: (input) =>
      storeCall(env, requestId, "write", (store) => store.trails.create(input)),
    updateTrail: (id, patch) =>
      storeCall(env, requestId, "write", (store) => store.trails.update(id, patch)),
    addTrailDecision: (trailId, input) =>
      storeCall(env, requestId, "write", (store) => store.trails.addDecision(trailId, input)),
    addTrailFinding: (trailId, input) =>
      storeCall(env, requestId, "write", (store) => store.trails.addFinding(trailId, input)),
  };
}

/**
 * The production diff read: the first source that can read the Change (C1 / 0248).
 *
 * @internal
 * @param env - The Worker environment; `OBJECTS` is the checkpoint store and `ARTIFACTS` the
 * mirror's namespace (D106).
 * @param requestId - The request's correlation id, for the log lines and the record read.
 * @param read - The Change's workspace and commit pair.
 * @returns The diff with the store it was read from, or a typed failure.
 *
 * @remarks
 * **The order — Artifacts, R2, machine — is decided here and nowhere else** (`review/selected.ts`).
 * The screen is handed the answer, never a binding: which store read the bytes is the server's
 * decision, and the source it names is what the screen shows. A deployment without `OBJECTS` and
 * without `ARTIFACTS` fails closed with `unavailable`; the mirror state beside a diff read from
 * R2 is the Workspace object's record, so a skipped or failed mirror is said out loud rather than
 * silently replaced.
 */
async function diffRead(
  env: WorkerEnv,
  requestId: string,
  read: ReviewDiffRead,
): Promise<ReviewDiffWithSourceReadResult> {
  const workspace =
    env.WORKSPACE === undefined || read.workspaceId === undefined
      ? undefined
      : env.WORKSPACE.get(env.WORKSPACE.idFromName(read.workspaceId));
  const result = await selectedReviewDiff(
    {
      objects: env.OBJECTS,
      artifacts: env.ARTIFACTS,
      workspaceId: read.workspaceId,
      workspace,
      requestId,
    },
    read.base,
    read.head,
  );
  if (!result.ok) {
    console.error("graphql: a review diff could not be read", requestId, result.failure);
    return { ok: false, code: result.failure, message: result.message };
  }
  return {
    ok: true,
    diff: result.value.diff,
    source: result.value.source,
    mirror: result.value.mirror,
    fallback: result.value.fallback,
  };
}

/**
 * The production hunk writes: the Workspace's versioned write over the checkpoint packs (C1).
 *
 * @internal
 * @remarks
 * **The UI is not the authority.** Keep / undo / apply read both sides of the file out of the
 * packs and write through `applyVersionedWrite`'s rules (`review/write.ts`), so the hunk the
 * caller saw and the bytes on disk are compared before anything is written: a file that moved is
 * `conflict`. The worker has no writable directory, so this build's port answers
 * `unavailable` when it is asked to write; the seam and its rules are the part 0232 proves,
 * and a writable Workspace reach is what turns it on.
 */
function defaultReview(env: WorkerEnv, requestId: string): GraphQLReviewWrites {
  return {
    hunk: async (action, input) => {
      const bucket = env.OBJECTS;
      // Without the packs there is no head side to keep, and one is not invented: fail closed.
      if (bucket === undefined) {
        return {
          ok: false,
          code: "unavailable",
          message: "This deployment has no checkpoint store to read the change from.",
        };
      }
      return writeHunk(new R2ReviewSource(bucket), action, input, requestId);
    },
  };
}

/**
 * Build the context one request's resolvers share.
 *
 * @param options - The edge request facts, optional read replacements, and the row budget.
 * @returns The context; its reads are the overrides where given, the production reads otherwise.
 */
export function createContext(options: GraphQLContextOptions): GraphQLContext {
  const reads = defaultReads(options.env, options.requestId, options.signal);
  const writes = defaultWrites(options.env, options.requestId);
  const policy = options.policy ?? defaultPolicy(options.env, options.requestId);
  const grants =
    options.grants ??
    grantPortOver({
      env: options.env,
      requestId: options.requestId,
      policy,
      machines: reads.machines,
      project: reads.project,
      store: () => storeWith(options.env, options.requestId),
      signal: options.signal ?? new AbortController().signal,
      token: options.grantToken ?? grantTokenFor(options.env),
    });
  const messages =
    options.messages ??
    conversationPortOver({
      env: options.env,
      requestId: options.requestId,
      policy,
      project: reads.project,
      store: () => storeWith(options.env, options.requestId),
      signal: options.signal ?? new AbortController().signal,
    });
  // The office port is the request's own (0237). The production caller (`handler.ts`) passes
  // `officePortOver`; a context built without one gets the port that refuses every call, so a
  // deployment with no office answers the failure union rather than reaching for a binding.
  const office: OfficePort = options.office ?? NO_OFFICE_PORT;
  const reviewOverrides = options.review ?? {};
  const review = defaultReview(options.env, options.requestId);
  const readOverrides = options.reads ?? {};
  const writeOverrides = options.writes ?? {};
  return {
    requestId: options.requestId,
    session: options.session,
    policy,
    grants,
    messages,
    budget: createRowBudget(options.maxRows),
    maxRowsPerList: options.maxRowsPerList,
    reads: {
      projects: readOverrides.projects ?? reads.projects,
      project: readOverrides.project ?? reads.project,
      trails: readOverrides.trails ?? reads.trails,
      trail: readOverrides.trail ?? reads.trail,
      trailChanges: readOverrides.trailChanges ?? reads.trailChanges,
      trailSessions: readOverrides.trailSessions ?? reads.trailSessions,
      trailFindings: readOverrides.trailFindings ?? reads.trailFindings,
      trailDecisions: readOverrides.trailDecisions ?? reads.trailDecisions,
      trailGates: readOverrides.trailGates ?? reads.trailGates,
      trailHead: readOverrides.trailHead ?? reads.trailHead,
      trailBase: readOverrides.trailBase ?? reads.trailBase,
      reviewDiff: readOverrides.reviewDiff ?? reads.reviewDiff,
      conversations: readOverrides.conversations ?? reads.conversations,
      indexState: readOverrides.indexState ?? reads.indexState,
      machines: readOverrides.machines ?? reads.machines,
    },
    writes: {
      createProject: writeOverrides.createProject ?? writes.createProject,
      enrollMachine: writeOverrides.enrollMachine ?? writes.enrollMachine,
      revokeMachine: writeOverrides.revokeMachine ?? writes.revokeMachine,
      createTrail: writeOverrides.createTrail ?? writes.createTrail,
      updateTrail: writeOverrides.updateTrail ?? writes.updateTrail,
      addTrailDecision: writeOverrides.addTrailDecision ?? writes.addTrailDecision,
      addTrailFinding: writeOverrides.addTrailFinding ?? writes.addTrailFinding,
    },
    review: {
      hunk: reviewOverrides.hunk ?? review.hunk,
    },
    office,
  };
}

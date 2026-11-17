import * as v from "valibot";
import type {
  Machine,
  MachineEnrollment,
  MachineRegistration,
  MachineRegistryRefusal,
  Project,
  ProjectId,
  Task,
} from "@hns/core";
import type {
  ConversationCursor,
  ConversationListQuery,
  ConversationPage,
  IndexStateRow,
  Store,
} from "@hns/store";
import type { WorkerEnv } from "../edge/env.ts";
import { createRowBudget, type RowBudget } from "../edge/limits.ts";
import type { Session } from "../edge/session.ts";
import { projectFor, storeFor, StoreUnavailableError } from "../edge/store.ts";
import { QueryReadError } from "./failures.ts";
import { probeAll } from "../machines/probe.ts";
import { policyFaceOver, type PolicyFace } from "./policy/face.ts";
import { grantPortOver, type GrantPort } from "./grants.ts";

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
  readonly tasks: (projectId: ProjectId) => Promise<readonly Task[]>;
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
   * The grant port: `requestGrant` asks a session object for one capability grant (0224).
   *
   * @remarks
   * The production port reads the active policy from D1, checks the project and the machine, and
   * forwards the request to the session object. A test replaces it with a fake that records what it
   * was asked, so the resolver's own checks are testable without a Durable Object.
   */
  readonly grants: GrantPort;
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

/** The production reads: D1 for projects, tasks, and the conversation index. */
function defaultReads(
  env: WorkerEnv,
  requestId: string,
  signal?: AbortSignal | undefined,
): GraphQLReads {
  return {
    projects: () => storeCall(env, requestId, "read", (store) => store.projects.list()),
    project: (projectId) => storeFailure(requestId, () => projectFor(env, projectId)),
    tasks: (projectId) => storeCall(env, requestId, "read", (store) => store.tasks.list(projectId)),
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
    });
  const readOverrides = options.reads ?? {};
  const writeOverrides = options.writes ?? {};
  return {
    requestId: options.requestId,
    session: options.session,
    policy,
    grants,
    budget: createRowBudget(options.maxRows),
    maxRowsPerList: options.maxRowsPerList,
    reads: {
      projects: readOverrides.projects ?? reads.projects,
      project: readOverrides.project ?? reads.project,
      tasks: readOverrides.tasks ?? reads.tasks,
      conversations: readOverrides.conversations ?? reads.conversations,
      indexState: readOverrides.indexState ?? reads.indexState,
      machines: readOverrides.machines ?? reads.machines,
    },
    writes: {
      createProject: writeOverrides.createProject ?? writes.createProject,
      enrollMachine: writeOverrides.enrollMachine ?? writes.enrollMachine,
      revokeMachine: writeOverrides.revokeMachine ?? writes.revokeMachine,
    },
  };
}

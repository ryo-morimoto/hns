import type { SignedGrant } from "@hns/core/capability";
import {
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
} from "graphql";
import type { GrantRequestRead, GrantRequestResult, GraphQLContext } from "../context.ts";
import { QueryReadError } from "../failures.ts";
import { MutationFailureType, mutationFailure, type MutationFailureView } from "./failure.ts";
import type { MutationModule } from "./index.ts";

/**
 * `requestGrant`: the Worker's one way to ask a Session for a capability grant (0224,
 * `docs/capability.md` §5, §10).
 *
 * @remarks
 * The Worker owns every fact a Session object may not read for itself (D049): the person's session,
 * the project and therefore the workspace, the machine registry, and the workspace's **active policy
 * revision** in D1. The context's `grants.request` gathers and checks them and forwards the snapshot
 * and the request to the session object's `POST /rpc/grants`, which issues, records and signs the
 * grant. This module is the GraphQL shape and the argument checks; the port holds the decisions, so
 * the resolver cannot issue a grant by itself.
 *
 * A run of the agent asks by passing its `runId` (its conversation id); the grant is then bound to
 * that run, and the Session revokes it when the run's abort reaches the object or when the Session
 * closes, after which a machine refuses it as `grant_revoked`. A person's grant ends with its expiry.
 *
 * **The token.** The answer carries the signed grant, a capability the caller holds until it expires
 * (30–60 seconds). It is written to no log, event, or row; this face logs failures only.
 */

/** The successful member of `requestGrant`: the grant as `GrantView` reads it. */
interface RequestGrantPayloadView {
  readonly __typename: "RequestGrantPayload";
  /** The signed grant: its fields flattened, and the signature the capability. */
  readonly grant: {
    readonly grantId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly machineId: string;
    readonly toolId: string;
    readonly toolVersion: string;
    readonly manifestHash: string;
    readonly scopeKind: string;
    readonly scopeRoots: string;
    readonly scopeNetwork: string;
    readonly scopeWritable: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly epoch: number;
    readonly policyHash: string;
    readonly maxCalls: number;
    readonly maxBytes: number;
    readonly alg: string;
    readonly keyId: string;
    readonly signature: string;
  };
  /** The policy revision the grant was issued under (its `epoch`). */
  readonly policyRevision: number;
}

/** The `requestGrant` union. */
export type RequestGrantView = RequestGrantPayloadView | MutationFailureView;

/** The `requestGrant` arguments. */
interface RequestGrantArgs {
  readonly input: GrantRequestRead;
}

/**
 * The grant as the caller reads it: the payload's fields and the signature over them.
 *
 * @remarks
 * One object rather than a payload inside a signed grant: every field here is a scalar, so a reader
 * that resolves it has nothing nested to disagree about, and the `signature` is the one
 * secret-shaped value an answer carries.
 */
const GrantViewType = new GraphQLObjectType({
  name: "GrantView",
  fields: () => ({
    grantId: { type: new GraphQLNonNull(GraphQLString) },
    workspaceId: { type: new GraphQLNonNull(GraphQLString) },
    sessionId: { type: new GraphQLNonNull(GraphQLString) },
    machineId: { type: new GraphQLNonNull(GraphQLString) },
    toolId: { type: new GraphQLNonNull(GraphQLString) },
    toolVersion: { type: new GraphQLNonNull(GraphQLString) },
    manifestHash: { type: new GraphQLNonNull(GraphQLString) },
    scopeKind: { type: new GraphQLNonNull(GraphQLString) },
    scopeRoots: { type: new GraphQLNonNull(GraphQLString) },
    scopeNetwork: { type: new GraphQLNonNull(GraphQLString) },
    scopeWritable: { type: new GraphQLNonNull(GraphQLString) },
    issuedAt: { type: new GraphQLNonNull(GraphQLString) },
    expiresAt: { type: new GraphQLNonNull(GraphQLString) },
    epoch: { type: new GraphQLNonNull(GraphQLInt) },
    /** The policy revision's own hash: the document the grant was issued under (0225). */
    policyHash: { type: new GraphQLNonNull(GraphQLString) },
    maxCalls: { type: new GraphQLNonNull(GraphQLInt) },
    maxBytes: { type: new GraphQLNonNull(GraphQLInt) },
    alg: { type: new GraphQLNonNull(GraphQLString) },
    keyId: { type: new GraphQLNonNull(GraphQLString) },
    /** The base64url signature over the payload's canonical JSON; the capability itself. */
    signature: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

/** A scope's printable members: the kind, and the members that kind has. */
interface GrantScopeView {
  readonly kind: string;
  readonly roots: string;
  readonly network: string;
  readonly writable: string;
}

/** The scope's printable members, by kind. */
function scopeView(scope: SignedGrant["payload"]["scope"]): GrantScopeView {
  switch (scope.kind) {
    case "read":
    case "write":
      return { kind: scope.kind, roots: scope.roots.join(","), network: "", writable: "" };
    case "exec":
      return {
        kind: scope.kind,
        roots: "",
        network: scope.network,
        writable: String(scope.writable),
      };
    case "exact":
      return { kind: scope.kind, roots: scope.callHash, network: "", writable: "" };
    default: {
      const unhandled: never = scope;
      throw new Error("a scope the contract does not know: " + String(unhandled));
    }
  }
}

/**
 * The `requestGrant` feature.
 *
 * @returns The module that adds `requestGrant(input)` to the Mutation root.
 */
export function requestGrantModule(): MutationModule {
  return {
    name: "grants",
    fields: (): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      const payload = new GraphQLObjectType({
        name: "RequestGrantPayload",
        fields: () => ({
          policyRevision: { type: new GraphQLNonNull(GraphQLInt) },
          grant: { type: new GraphQLNonNull(GrantViewType) },
        }),
      });
      const result = new GraphQLUnionType({
        name: "RequestGrantResult",
        types: [payload, MutationFailureType],
        resolveType: (value: RequestGrantView): string => value.__typename,
      });
      const input = new GraphQLInputObjectType({
        name: "RequestGrantInput",
        fields: {
          projectId: { type: new GraphQLNonNull(GraphQLString) },
          machineId: { type: new GraphQLNonNull(GraphQLString) },
          toolId: { type: new GraphQLNonNull(GraphQLString) },
          /** The contract's tool version; absent means the version the Worker's table declares. */
          toolVersion: { type: GraphQLString },
          /** The model-facing JSON bound the grant must cover; absent means the manifest's own. */
          maxBytes: { type: GraphQLInt },
          /** The conversation whose run asks; a grant bound to it is revoked when the run ends. */
          runId: { type: GraphQLString },
          /** The caller's manifest hash; the object checks it, and refuses a request without one. */
          manifestHash: { type: GraphQLString },
        },
      });
      return {
        requestGrant: {
          type: new GraphQLNonNull(result),
          args: { input: { type: new GraphQLNonNull(input) } },
          resolve: async (
            _source: undefined,
            args: RequestGrantArgs,
            context: GraphQLContext,
          ): Promise<RequestGrantView> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to request a grant.");
            }
            let answer: GrantRequestResult;
            try {
              answer = await context.grants.request(args.input, context.session.subject);
            } catch (error) {
              // A store or object outage is `unavailable`; a defect is a 500, never a grant.
              if (error instanceof QueryReadError) {
                return mutationFailure("unavailable", error.message);
              }
              throw error;
            }
            // Plain JSON, built field by field: GraphQL resolves a payload's fields only when they are
            // enumerable members of ordinary objects, and a value the port handed back must not
            // decide that. The signature travels here and nowhere else.
            if (!answer.ok) return mutationFailure(answer.code, answer.message);
            // Plain JSON, field by field: GraphQL resolves a payload's fields only when they are
            // enumerable members of an ordinary object, and the value the port handed back must not
            // decide that. The signature travels here and nowhere else.
            const grant = answer.grant;
            const scope = scopeView(grant.payload.scope);
            const view: RequestGrantPayloadView = {
              __typename: "RequestGrantPayload",
              grant: {
                grantId: grant.payload.grantId,
                workspaceId: grant.payload.workspaceId,
                sessionId: grant.payload.sessionId,
                machineId: grant.payload.machineId,
                toolId: grant.payload.toolId,
                toolVersion: grant.payload.toolVersion,
                manifestHash: grant.payload.manifestHash,
                scopeKind: scope.kind,
                scopeRoots: scope.roots,
                scopeNetwork: scope.network,
                scopeWritable: scope.writable,
                issuedAt: grant.payload.issuedAt,
                expiresAt: grant.payload.expiresAt,
                epoch: grant.payload.epoch,
                policyHash: grant.payload.policyHash,
                maxCalls: grant.payload.maxCalls,
                maxBytes: grant.payload.maxBytes,
                alg: grant.payload.alg,
                keyId: grant.payload.keyId,
                signature: grant.signature,
              },
              policyRevision: grant.payload.epoch,
            };
            return view;
          },
        },
      };
    },
  };
}

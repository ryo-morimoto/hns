import * as v from "valibot";
import {
  DEVICE_KEY_BASE64URL_PATTERN,
  decodeDeviceKey,
  parseMachineEnrollment,
  type Machine,
} from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";
import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
} from "graphql";
import type { GraphQLContext, MachineEnrollRefusal } from "../context.ts";
import { QueryReadError } from "../failures.ts";
import { machineView, type MachineView } from "../views.ts";
import { MutationFailureType, mutationFailure, type MutationFailureView } from "./failure.ts";
import type { MutationModule } from "./index.ts";

/** The successful member of `registerMachine`: the machine, and whether the key was replaced. */
export interface RegisterMachinePayloadView {
  readonly __typename: "RegisterMachinePayload";
  readonly machine: MachineView;
  /** True when the name existed and the key was replaced as a reimage (D087 U-02). */
  readonly reimaged: boolean;
  /** The fingerprint of the key the reimage replaced, or null for a first enrollment. */
  readonly previousFingerprint: string | null;
}

/** The successful member of `revokeMachine`: the machine, now revoked. */
export interface RevokeMachinePayloadView {
  readonly __typename: "RevokeMachinePayload";
  readonly machine: MachineView;
}

/** The `registerMachine` union. */
export type RegisterMachineResult = RegisterMachinePayloadView | MutationFailureView;

/** The `revokeMachine` union. */
export type RevokeMachineResult = RevokeMachinePayloadView | MutationFailureView;

/** The `registerMachine` input values. */
interface RegisterMachineInput {
  readonly name: string;
  readonly hostname: string;
  readonly publicKey: string;
  readonly agentVersion: string;
}

/** The `registerMachine` arguments. */
interface RegisterMachineArgs {
  readonly input: RegisterMachineInput;
}

/**
 * The `registerMachine` input, as a GraphQL input object.
 *
 * @remarks
 * One input rather than four scalar arguments: the values belong together (a name and the key it
 * vouches for), and a single input keeps the published line short enough to read.
 */
export const RegisterMachineInputType = new GraphQLInputObjectType({
  name: "RegisterMachineInput",
  fields: {
    /** The unique machine name; lowercase letters, digits, and `-`. */
    name: { type: new GraphQLNonNull(GraphQLString) },
    /** The tunnel hostname, a DNS name without a scheme or a path. */
    hostname: { type: new GraphQLNonNull(GraphQLString) },
    /** The device key's public half, base64url; the secret never travels. */
    publicKey: { type: new GraphQLNonNull(GraphQLString) },
    /** The agent version the machine reported. */
    agentVersion: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** The `revokeMachine` arguments: the raw machine id. */
interface RevokeMachineArgs {
  readonly id: string;
}

/**
 * Map the registry's enrollment refusal to a mutation failure.
 *
 * @internal
 * @remarks
 * Two refusals are distinguished deliberately: `revoked` means the name belonged to a machine
 * that was revoked, which is a different answer from `conflict` (a live machine holds the name but
 * a reimage did not apply). `invalid_request` is the shape of the input; `name_taken` cannot
 * happen in the registry today (a same-name enrollment is always a reimage), but the union is kept
 * closed.
 */
function enrollFailure(refusal: MachineEnrollRefusal): MutationFailureView {
  switch (refusal) {
    case "revoked":
      // Not `conflict`: a conflict is retryable, and this identity is gone for good.
      return mutationFailure(
        "revoked",
        "That name belongs to a revoked machine; enroll under a new name.",
      );
    case "name_taken":
      return mutationFailure("conflict", "That name is already registered.");
    case "invalid_request":
      return mutationFailure("invalid_request", "The enrollment is not a valid machine.");
    case "not_found":
      // An enrollment names no id, so this cannot come from the registry; keep the switch closed.
      return mutationFailure("not_found", "No machine has this id.");
  }
}

/**
 * The machines feature (0148): `registerMachine` and `revokeMachine`.
 *
 * @returns The module that adds both fields to the Mutation root.
 *
 * @remarks
 * The caller is the authenticated session (0198 / D059): the edge proved a cookie, and this
 * resolver records the subject as each event's actor. There is no per-machine owner yet, so the
 * check is that a subject exists; the machine id comes from the registry, never from the caller.
 *
 * **Enrollment authorization.** A machine does not enroll itself here: the machine prints its
 * device public key (and fingerprint), and a signed-in person pastes it. That paste is the
 * approval, and it is the smallest fail-closed form D087 can have without a second credential
 * system: the private half never leaves the machine, the key must decode to 32 bytes, and a
 * revoked name cannot be re-enrolled. A machine-issued enrollment token is the natural follow-up
 * if machines must enroll without a person.
 */
export function machinesModule(): MutationModule {
  return {
    name: "machines",
    fields: (
      objects: ReadonlyMap<string, GraphQLObjectType>,
    ): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      const machine = objects.get("Machine");
      if (machine === undefined) throw new Error("the model has no GraphQL type Machine");
      const registerPayload = new GraphQLObjectType({
        name: "RegisterMachinePayload",
        fields: {
          machine: { type: new GraphQLNonNull(machine) },
          reimaged: { type: new GraphQLNonNull(GraphQLBoolean) },
          previousFingerprint: { type: GraphQLString },
        },
      });
      const revokePayload = new GraphQLObjectType({
        name: "RevokeMachinePayload",
        fields: { machine: { type: new GraphQLNonNull(machine) } },
      });
      const registerResult = new GraphQLUnionType({
        name: "RegisterMachineResult",
        types: [registerPayload, MutationFailureType],
        resolveType: (value: RegisterMachineResult): string => value.__typename,
      });
      const revokeResult = new GraphQLUnionType({
        name: "RevokeMachineResult",
        types: [revokePayload, MutationFailureType],
        resolveType: (value: RevokeMachineResult): string => value.__typename,
      });
      return {
        registerMachine: {
          type: new GraphQLNonNull(registerResult),
          args: { input: { type: new GraphQLNonNull(RegisterMachineInputType) } },
          resolve: async (
            _source: undefined,
            args: RegisterMachineArgs,
            context: GraphQLContext,
          ): Promise<RegisterMachineResult> => {
            const input = args.input;
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to register a machine.");
            }
            if (!DEVICE_KEY_BASE64URL_PATTERN.test(input.publicKey)) {
              return mutationFailure(
                "invalid_request",
                "publicKey must be the device key's 32-byte public half, base64url.",
              );
            }
            let enrollment;
            try {
              enrollment = parseMachineEnrollment({
                name: input.name,
                hostname: input.hostname,
                publicKey: input.publicKey,
                agentVersion: input.agentVersion,
              });
            } catch (error) {
              if (!(error instanceof v.ValiError)) throw error;
              return mutationFailure(
                "invalid_request",
                "name, hostname, and agentVersion must be valid machine values.",
              );
            }
            if (!context.budget.spend(2)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            // The key must decode now, before the store sees it: a value that decodes in the
            // schema but not here would be stored as a malformed blob.
            try {
              decodeDeviceKey(enrollment.publicKey);
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              return mutationFailure(
                "invalid_request",
                "publicKey must be the device key's 32-byte public half, base64url.",
              );
            }
            let outcome: Awaited<ReturnType<GraphQLContext["writes"]["enrollMachine"]>>;
            try {
              outcome = await context.writes.enrollMachine(enrollment, context.session.subject);
            } catch (error) {
              if (error instanceof QueryReadError) {
                return mutationFailure(error.code, error.message);
              }
              throw error;
            }
            if (
              outcome === "revoked" ||
              outcome === "name_taken" ||
              outcome === "invalid_request" ||
              outcome === "not_found"
            ) {
              return enrollFailure(outcome);
            }
            return {
              __typename: "RegisterMachinePayload",
              machine: machineView(outcome.machine),
              reimaged: outcome.kind === "reimaged",
              previousFingerprint: outcome.kind === "reimaged" ? outcome.previousFingerprint : null,
            };
          },
        },
        revokeMachine: {
          type: new GraphQLNonNull(revokeResult),
          args: { id: { type: new GraphQLNonNull(GraphQLString) } },
          resolve: async (
            _source: undefined,
            args: RevokeMachineArgs,
            context: GraphQLContext,
          ): Promise<RevokeMachineResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to revoke a machine.");
            }
            const decoded = fromGlobalId(args.id.trim());
            if (!decoded.ok || decoded.value.type !== "Machine" || decoded.value.id.length === 0) {
              return mutationFailure("invalid_request", "id must be a Machine global id.");
            }
            const id = decoded.value.id;
            if (!context.budget.spend(2)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            let revoked: Machine | undefined;
            try {
              revoked = await context.writes.revokeMachine(id, context.session.subject);
            } catch (error) {
              if (error instanceof QueryReadError) {
                return mutationFailure(error.code, error.message);
              }
              throw error;
            }
            if (revoked === undefined) {
              return mutationFailure("not_found", "No machine has this id.");
            }
            return { __typename: "RevokeMachinePayload", machine: machineView(revoked) };
          },
        },
      };
    },
  };
}

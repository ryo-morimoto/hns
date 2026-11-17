import { GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType } from "graphql";
import type { GraphQLContext } from "../../src/graphql/context.ts";
import {
  MutationFailureType,
  mutationFailure,
  type MutationFailureView,
} from "../../src/graphql/mutations/failure.ts";
import type { MutationModule } from "../../src/graphql/mutations/index.ts";

/** The successful member of the fixture mutation's result union. */
interface NotePayloadView {
  readonly __typename: "NotePayload";
  readonly text: string;
  readonly actor: string;
}

/**
 * The fixture feature: one note that `owner` may create.
 *
 * @param owner - The session subject that owns the note. Any other caller is refused.
 * @returns A module that proves the skeleton's contract: authorization in the resolver, typed
 * failures as union members, and a payload that carries the caller.
 *
 * @remarks
 * Test-only. The production collection stays empty until the first feature (0127) registers.
 */
export function noteMutation(owner: string): MutationModule {
  const payload = new GraphQLObjectType({
    name: "NotePayload",
    fields: {
      text: { type: new GraphQLNonNull(GraphQLString) },
      actor: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
  const result = new GraphQLUnionType({
    name: "NoteResult",
    types: [payload, MutationFailureType],
    resolveType: (value: { readonly __typename: string }): string => value.__typename,
  });
  return {
    name: "notes",
    fields: () => ({
      createNote: {
        type: new GraphQLNonNull(result),
        args: { text: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (
          _source: undefined,
          args: { readonly text: string },
          context: GraphQLContext,
        ): NotePayloadView | MutationFailureView => {
          if (context.session.subject !== owner) {
            return mutationFailure("forbidden", "The caller does not own this note.");
          }
          if (args.text.trim().length === 0) {
            return mutationFailure("invalid_argument", "text must not be blank.");
          }
          if (!context.budget.spend(1)) {
            return mutationFailure("limit_exceeded", "This request writes more rows than it may.");
          }
          return { __typename: "NotePayload", text: args.text, actor: context.session.subject };
        },
      },
    }),
  };
}

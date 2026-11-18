import {
  GraphQLNonNull,
  GraphQLString,
  type GraphQLFieldConfigMap,
  type GraphQLObjectType,
} from "graphql";
import type { GraphQLContext } from "../context.ts";
import {
  DocumentPreviewResultType,
  officeFields,
  requestDocumentPreviewResolver,
} from "../office.ts";
import type { MutationModule } from "./index.ts";

/**
 * The office face's write (0237): `requestDocumentPreview`.
 *
 * @returns The module that adds the one field to the Mutation root.
 *
 * @remarks
 * A module of its own rather than a member of another feature: the mutation is the office face's
 * only write, and the read (`documentPreview`) and the probe (`officeEngine`) live on the Query
 * root. The field's union type is the Query root's `DocumentPreviewResult`, taken from the same
 * module, so a client reads one union for both directions.
 */
export function officeModule(): MutationModule {
  return {
    name: "office",
    fields: (
      _objects: ReadonlyMap<string, GraphQLObjectType>,
    ): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      const request = officeFields().mutation["requestDocumentPreview"];
      if (request === undefined) throw new Error("the office fields define no request");
      return {
        requestDocumentPreview: {
          type: new GraphQLNonNull(DocumentPreviewResultType),
          args: {
            path: { type: new GraphQLNonNull(GraphQLString) },
            workspaceId: { type: GraphQLString },
          },
          // The field configs the office module builds always carry their resolver; the type
          // allows an absent one, so the check is what makes this a field rather than a stub.
          resolve: request.resolve ?? requestDocumentPreviewResolver,
        },
      };
    },
  };
}

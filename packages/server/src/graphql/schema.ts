import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
} from "graphql";
import { buildSchema, publicEnumName } from "@hns/core/graphql";
import type { GraphQLContext } from "./context.ts";
import { QUERY_FAILURE_CODES } from "./failures.ts";
import { resolveConversations, resolveProjects, resolveTasks } from "./resolvers.ts";

/** The expected failure codes, named as GraphQL enum values. */
const QueryErrorCodeEnum = new GraphQLEnumType({
  name: "QueryErrorCode",
  values: Object.fromEntries(
    QUERY_FAILURE_CODES.map((code) => [publicEnumName(code), { value: code }]),
  ),
});

/** The failure member every result union carries. */
const QueryFailureType = new GraphQLObjectType({
  name: "QueryFailure",
  fields: {
    code: { type: new GraphQLNonNull(QueryErrorCodeEnum) },
    message: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/**
 * A model object type by GraphQL name.
 *
 * @internal
 * @throws Error when the model does not register the type, which means the SDL and the server
 * disagree.
 */
function objectType(
  objects: ReadonlyMap<string, GraphQLObjectType>,
  name: string,
): GraphQLObjectType {
  const type = objects.get(name);
  if (type === undefined) throw new Error("the model has no GraphQL type " + name);
  return type;
}

/** A payload type that wraps one list field. */
function listPayload(name: string, field: string, element: GraphQLObjectType): GraphQLObjectType {
  return new GraphQLObjectType({
    name,
    fields: {
      [field]: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(element))) },
    },
  });
}

/**
 * A result union: the payload or a typed failure.
 *
 * @internal
 * @remarks
 * The resolved value says which member it is by its `__typename`, so a failure can never be
 * mistaken for an empty list and no runtime class check is needed.
 */
function resultUnion(name: string, payload: GraphQLObjectType): GraphQLUnionType {
  return new GraphQLUnionType({
    name,
    types: [payload, QueryFailureType],
    resolveType: (value: { readonly __typename: string }): string => value.__typename,
  });
}

/**
 * Build the Query root over the model's own object types.
 *
 * @param objects - The model object types the schema is built with.
 * @returns The Query root; each field names its source in {@link resolveProjects},
 * {@link resolveTasks}, or {@link resolveConversations}.
 *
 * @remarks
 * The root references the instances it is given, so the schema holds one `Project` type rather
 * than a second definition with the same name.
 */
function buildQuery(objects: ReadonlyMap<string, GraphQLObjectType>): GraphQLObjectType {
  const projectList = listPayload("ProjectList", "projects", objectType(objects, "Project"));
  const conversationList = listPayload(
    "ConversationList",
    "conversations",
    objectType(objects, "Conversation"),
  );
  const taskList = listPayload("TaskList", "tasks", objectType(objects, "Task"));

  return new GraphQLObjectType<undefined, GraphQLContext>({
    name: "Query",
    fields: {
      projects: {
        type: new GraphQLNonNull(resultUnion("ProjectListResult", projectList)),
        args: { first: { type: GraphQLInt } },
        resolve: resolveProjects,
      },
      conversations: {
        type: new GraphQLNonNull(resultUnion("ConversationListResult", conversationList)),
        args: {
          projectId: { type: new GraphQLNonNull(GraphQLID) },
          first: { type: GraphQLInt },
        },
        resolve: resolveConversations,
      },
      tasks: {
        type: new GraphQLNonNull(resultUnion("TaskListResult", taskList)),
        args: {
          projectId: { type: new GraphQLNonNull(GraphQLID) },
          first: { type: GraphQLInt },
        },
        resolve: resolveTasks,
      },
    },
  });
}

/**
 * Build the schema the Worker serves.
 *
 * @returns The model types, the result unions, and the Query root, ready for `validate` and
 * `execute`.
 */
export function buildGraphQLSchema(): GraphQLSchema {
  return buildSchema(buildQuery);
}

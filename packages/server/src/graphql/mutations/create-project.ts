import * as v from "valibot";
import { parseProjectWorkspaceRoot, type Project } from "@hns/core";
import {
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
} from "graphql";
import type { GraphQLContext } from "../context.ts";
import { QueryReadError } from "../failures.ts";
import { projectView, type ProjectView } from "../views.ts";
import { MutationFailureType, mutationFailure, type MutationFailureView } from "./failure.ts";
import type { MutationModule } from "./index.ts";

/** The successful member: the project the store created. */
interface CreateProjectPayloadView {
  readonly __typename: "CreateProjectPayload";
  readonly project: ProjectView;
}

/** The result union: the created project, or a typed refusal. */
type CreateProjectResult = CreateProjectPayloadView | MutationFailureView;

/** The names a project may carry, matching the conversation title bound. */
const MAX_NAME_LENGTH = 200;

/**
 * The `createProject` feature.
 *
 * @returns The module that adds `createProject(name, workspaceRoot)` to the Mutation root.
 *
 * @remarks
 * The root is fixed at creation (D080) and validated here before the store sees it; the store
 * validates again, so a caller that skipped this resolver cannot store a non-canonical root.
 * `workspaceRoot` must be non-empty: only the seeded default project points at the machine ROOT.
 * The caller is the authenticated session; there is no per-project owner yet, so the check is
 * that a subject exists, and the row budget bounds the write.
 */
export function createProjectModule(): MutationModule {
  return {
    name: "projects",
    fields: (
      objects: ReadonlyMap<string, GraphQLObjectType>,
    ): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      const project = objects.get("Project");
      if (project === undefined) throw new Error("the model has no GraphQL type Project");
      const payload = new GraphQLObjectType({
        name: "CreateProjectPayload",
        fields: {
          project: { type: new GraphQLNonNull(project) },
        },
      });
      const result = new GraphQLUnionType({
        name: "CreateProjectResult",
        types: [payload, MutationFailureType],
        resolveType: (value: CreateProjectResult): string => value.__typename,
      });
      return {
        createProject: {
          type: new GraphQLNonNull(result),
          args: {
            name: { type: new GraphQLNonNull(GraphQLString) },
            workspaceRoot: { type: new GraphQLNonNull(GraphQLString) },
          },
          resolve: async (
            _source: undefined,
            args: { readonly name: string; readonly workspaceRoot: string },
            context: GraphQLContext,
          ): Promise<CreateProjectResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to create a project.");
            }
            const name = args.name.trim();
            if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
              return mutationFailure(
                "invalid_request",
                "name must be 1-" + String(MAX_NAME_LENGTH) + " characters.",
              );
            }
            let workspaceRoot: string;
            try {
              workspaceRoot = parseProjectWorkspaceRoot(args.workspaceRoot);
            } catch (error) {
              if (!(error instanceof v.ValiError)) throw error;
              return mutationFailure(
                "invalid_request",
                "workspaceRoot must name a directory below the machine root.",
              );
            }
            if (!context.budget.spend(1)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            let created: Project;
            try {
              created = await context.writes.createProject({ name, workspaceRoot });
            } catch (error) {
              if (error instanceof QueryReadError) {
                return mutationFailure(error.code, error.message);
              }
              throw error;
            }
            return { __typename: "CreateProjectPayload", project: projectView(created) };
          },
        },
      };
    },
  };
}

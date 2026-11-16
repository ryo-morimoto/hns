/**
 * @generated SignedSource<<dafb9b9dac5adf3ac1785ceed089c40f>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from "relay-runtime";
export type QueryErrorCode =
  | "INVALID_ARGUMENT"
  | "LIMIT_EXCEEDED"
  | "UNAVAILABLE"
  | "%future added value";
export type TaskStatus = "BLOCKED" | "DOING" | "DONE" | "TODO" | "%future added value";
export type WorkspaceQuery$variables = {
  projectId: string;
};
export type WorkspaceQuery$data = {
  readonly conversations:
    | {
        readonly __typename: "ConversationList";
        readonly conversations: ReadonlyArray<{
          readonly createdAt: string;
          readonly deletedAt: string | null | undefined;
          readonly id: string;
          readonly isArchived: boolean;
          readonly projectId: string;
          readonly title: string;
          readonly updatedAt: string | null | undefined;
        }>;
      }
    | {
        readonly __typename: "QueryFailure";
        readonly code: QueryErrorCode;
        readonly message: string;
      }
    | {
        // This will never be '%other', but we need some
        // value in case none of the concrete values match.
        readonly __typename: "%other";
      };
  readonly tasks:
    | {
        readonly __typename: "QueryFailure";
        readonly code: QueryErrorCode;
        readonly message: string;
      }
    | {
        readonly __typename: "TaskList";
        readonly tasks: ReadonlyArray<{
          readonly createdAt: string;
          readonly id: string;
          readonly projectId: string;
          readonly status: TaskStatus;
          readonly title: string;
          readonly updatedAt: string;
        }>;
      }
    | {
        // This will never be '%other', but we need some
        // value in case none of the concrete values match.
        readonly __typename: "%other";
      };
};
export type WorkspaceQuery = {
  response: WorkspaceQuery$data;
  variables: WorkspaceQuery$variables;
};

const node: ConcreteRequest = (function () {
  var v0 = [
      {
        defaultValue: null,
        kind: "LocalArgument",
        name: "projectId",
      },
    ],
    v1 = [
      {
        kind: "Variable",
        name: "projectId",
        variableName: "projectId",
      },
    ],
    v2 = {
      alias: null,
      args: null,
      kind: "ScalarField",
      name: "__typename",
      storageKey: null,
    },
    v3 = {
      alias: null,
      args: null,
      kind: "ScalarField",
      name: "id",
      storageKey: null,
    },
    v4 = {
      alias: null,
      args: null,
      kind: "ScalarField",
      name: "projectId",
      storageKey: null,
    },
    v5 = {
      alias: null,
      args: null,
      kind: "ScalarField",
      name: "title",
      storageKey: null,
    },
    v6 = {
      alias: null,
      args: null,
      kind: "ScalarField",
      name: "createdAt",
      storageKey: null,
    },
    v7 = {
      alias: null,
      args: null,
      kind: "ScalarField",
      name: "updatedAt",
      storageKey: null,
    },
    v8 = {
      kind: "InlineFragment",
      selections: [
        {
          alias: null,
          args: null,
          kind: "ScalarField",
          name: "code",
          storageKey: null,
        },
        {
          alias: null,
          args: null,
          kind: "ScalarField",
          name: "message",
          storageKey: null,
        },
      ],
      type: "QueryFailure",
      abstractKey: null,
    },
    v9 = [
      {
        alias: null,
        args: v1 /*: any*/,
        concreteType: null,
        kind: "LinkedField",
        name: "conversations",
        plural: false,
        selections: [
          v2 /*: any*/,
          {
            kind: "InlineFragment",
            selections: [
              {
                alias: null,
                args: null,
                concreteType: "Conversation",
                kind: "LinkedField",
                name: "conversations",
                plural: true,
                selections: [
                  v3 /*: any*/,
                  v4 /*: any*/,
                  v5 /*: any*/,
                  v6 /*: any*/,
                  v7 /*: any*/,
                  {
                    alias: null,
                    args: null,
                    kind: "ScalarField",
                    name: "isArchived",
                    storageKey: null,
                  },
                  {
                    alias: null,
                    args: null,
                    kind: "ScalarField",
                    name: "deletedAt",
                    storageKey: null,
                  },
                ],
                storageKey: null,
              },
            ],
            type: "ConversationList",
            abstractKey: null,
          },
          v8 /*: any*/,
        ],
        storageKey: null,
      },
      {
        alias: null,
        args: v1 /*: any*/,
        concreteType: null,
        kind: "LinkedField",
        name: "tasks",
        plural: false,
        selections: [
          v2 /*: any*/,
          {
            kind: "InlineFragment",
            selections: [
              {
                alias: null,
                args: null,
                concreteType: "Task",
                kind: "LinkedField",
                name: "tasks",
                plural: true,
                selections: [
                  v3 /*: any*/,
                  v4 /*: any*/,
                  v5 /*: any*/,
                  {
                    alias: null,
                    args: null,
                    kind: "ScalarField",
                    name: "status",
                    storageKey: null,
                  },
                  v6 /*: any*/,
                  v7 /*: any*/,
                ],
                storageKey: null,
              },
            ],
            type: "TaskList",
            abstractKey: null,
          },
          v8 /*: any*/,
        ],
        storageKey: null,
      },
    ];
  return {
    fragment: {
      argumentDefinitions: v0 /*: any*/,
      kind: "Fragment",
      metadata: null,
      name: "WorkspaceQuery",
      selections: v9 /*: any*/,
      type: "Query",
      abstractKey: null,
    },
    kind: "Request",
    operation: {
      argumentDefinitions: v0 /*: any*/,
      kind: "Operation",
      name: "WorkspaceQuery",
      selections: v9 /*: any*/,
    },
    params: {
      cacheID: "a347a4c797d0d572a2288983608df761",
      id: null,
      metadata: {},
      name: "WorkspaceQuery",
      operationKind: "query",
      text: "query WorkspaceQuery(\n  $projectId: ID!\n) {\n  conversations(projectId: $projectId) {\n    __typename\n    ... on ConversationList {\n      conversations {\n        id\n        projectId\n        title\n        createdAt\n        updatedAt\n        isArchived\n        deletedAt\n      }\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n  tasks(projectId: $projectId) {\n    __typename\n    ... on TaskList {\n      tasks {\n        id\n        projectId\n        title\n        status\n        createdAt\n        updatedAt\n      }\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n}\n",
    },
  };
})();

(node as any).hash = "2eab394310b81c3dfdf23f15a86a64fe";

export default node;

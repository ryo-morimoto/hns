/**
 * @generated SignedSource<<7c1b3d5274925c07a22895892520d4f0>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type QueryFailureCode = "INVALID_REQUEST" | "LIMIT_EXCEEDED" | "UNAVAILABLE" | "%future added value";
export type ShellWorkspaceQuery$variables = {
  hasProject: boolean;
  projectId: string;
};
export type ShellWorkspaceQuery$data = {
  readonly conversations?: {
    readonly __typename: "ConversationList";
    readonly " $fragmentSpreads": FragmentRefs<"SidebarConversations">;
  } | {
    readonly __typename: "QueryFailure";
    readonly code: QueryFailureCode;
    readonly message: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
  readonly tasks?: {
    readonly __typename: "QueryFailure";
    readonly code: QueryFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "TaskList";
    readonly " $fragmentSpreads": FragmentRefs<"SidebarTasks">;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type ShellWorkspaceQuery = {
  response: ShellWorkspaceQuery$data;
  variables: ShellWorkspaceQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "hasProject"
},
v1 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "projectId"
},
v2 = [
  {
    "kind": "Variable",
    "name": "projectId",
    "variableName": "projectId"
  }
],
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "__typename",
  "storageKey": null
},
v4 = {
  "kind": "InlineFragment",
  "selections": [
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "code",
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "message",
      "storageKey": null
    }
  ],
  "type": "QueryFailure",
  "abstractKey": null
},
v5 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v6 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "title",
  "storageKey": null
};
return {
  "fragment": {
    "argumentDefinitions": [
      (v0/*: any*/),
      (v1/*: any*/)
    ],
    "kind": "Fragment",
    "metadata": null,
    "name": "ShellWorkspaceQuery",
    "selections": [
      {
        "condition": "hasProject",
        "kind": "Condition",
        "passingValue": true,
        "selections": [
          {
            "alias": null,
            "args": (v2/*: any*/),
            "concreteType": null,
            "kind": "LinkedField",
            "name": "conversations",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "kind": "InlineFragment",
                "selections": [
                  {
                    "args": null,
                    "kind": "FragmentSpread",
                    "name": "SidebarConversations"
                  }
                ],
                "type": "ConversationList",
                "abstractKey": null
              },
              (v4/*: any*/)
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": (v2/*: any*/),
            "concreteType": null,
            "kind": "LinkedField",
            "name": "tasks",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "kind": "InlineFragment",
                "selections": [
                  {
                    "args": null,
                    "kind": "FragmentSpread",
                    "name": "SidebarTasks"
                  }
                ],
                "type": "TaskList",
                "abstractKey": null
              },
              (v4/*: any*/)
            ],
            "storageKey": null
          }
        ]
      }
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [
      (v1/*: any*/),
      (v0/*: any*/)
    ],
    "kind": "Operation",
    "name": "ShellWorkspaceQuery",
    "selections": [
      {
        "condition": "hasProject",
        "kind": "Condition",
        "passingValue": true,
        "selections": [
          {
            "alias": null,
            "args": (v2/*: any*/),
            "concreteType": null,
            "kind": "LinkedField",
            "name": "conversations",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "kind": "InlineFragment",
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "Conversation",
                    "kind": "LinkedField",
                    "name": "conversations",
                    "plural": true,
                    "selections": [
                      (v5/*: any*/),
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "projectId",
                        "storageKey": null
                      },
                      (v6/*: any*/)
                    ],
                    "storageKey": null
                  }
                ],
                "type": "ConversationList",
                "abstractKey": null
              },
              (v4/*: any*/)
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": (v2/*: any*/),
            "concreteType": null,
            "kind": "LinkedField",
            "name": "tasks",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "kind": "InlineFragment",
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "Task",
                    "kind": "LinkedField",
                    "name": "tasks",
                    "plural": true,
                    "selections": [
                      (v5/*: any*/),
                      (v6/*: any*/),
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "status",
                        "storageKey": null
                      }
                    ],
                    "storageKey": null
                  }
                ],
                "type": "TaskList",
                "abstractKey": null
              },
              (v4/*: any*/)
            ],
            "storageKey": null
          }
        ]
      }
    ]
  },
  "params": {
    "cacheID": "f9de756bef1732dbc00118e009a58825",
    "id": null,
    "metadata": {},
    "name": "ShellWorkspaceQuery",
    "operationKind": "query",
    "text": "query ShellWorkspaceQuery(\n  $projectId: ID!\n  $hasProject: Boolean!\n) {\n  conversations(projectId: $projectId) @include(if: $hasProject) {\n    __typename\n    ... on ConversationList {\n      ...SidebarConversations\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n  tasks(projectId: $projectId) @include(if: $hasProject) {\n    __typename\n    ... on TaskList {\n      ...SidebarTasks\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n}\n\nfragment SidebarConversations on ConversationList {\n  conversations {\n    id\n    projectId\n    title\n  }\n}\n\nfragment SidebarTasks on TaskList {\n  tasks {\n    id\n    title\n    status\n  }\n}\n"
  }
};
})();

(node as any).hash = "263022c2b207250f1e4dc144d166bd41";

export default node;

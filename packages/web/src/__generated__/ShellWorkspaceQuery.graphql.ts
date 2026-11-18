/**
 * @generated SignedSource<<a6b3fd52bb88003aa980dfd11141aaaa>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type QueryFailureCode = "INVALID_REQUEST" | "LIMIT_EXCEEDED" | "NOT_FOUND" | "UNAVAILABLE" | "%future added value";
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
  readonly trails?: {
    readonly __typename: "QueryFailure";
    readonly code: QueryFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "TrailList";
    readonly " $fragmentSpreads": FragmentRefs<"SidebarTrails">;
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
  "name": "projectId",
  "storageKey": null
},
v7 = {
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
            "name": "trails",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "kind": "InlineFragment",
                "selections": [
                  {
                    "args": null,
                    "kind": "FragmentSpread",
                    "name": "SidebarTrails"
                  }
                ],
                "type": "TrailList",
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
                      (v6/*: any*/),
                      (v7/*: any*/)
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
            "name": "trails",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "kind": "InlineFragment",
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "Trail",
                    "kind": "LinkedField",
                    "name": "trails",
                    "plural": true,
                    "selections": [
                      (v5/*: any*/),
                      (v6/*: any*/),
                      (v7/*: any*/),
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "state",
                        "storageKey": null
                      }
                    ],
                    "storageKey": null
                  }
                ],
                "type": "TrailList",
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
    "cacheID": "19c3c38f6c54f4fabd51f351655f4e6d",
    "id": null,
    "metadata": {},
    "name": "ShellWorkspaceQuery",
    "operationKind": "query",
    "text": "query ShellWorkspaceQuery(\n  $projectId: ID!\n  $hasProject: Boolean!\n) {\n  conversations(projectId: $projectId) @include(if: $hasProject) {\n    __typename\n    ... on ConversationList {\n      ...SidebarConversations\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n  trails(projectId: $projectId) @include(if: $hasProject) {\n    __typename\n    ... on TrailList {\n      ...SidebarTrails\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n}\n\nfragment SidebarConversations on ConversationList {\n  conversations {\n    id\n    projectId\n    title\n  }\n}\n\nfragment SidebarTrails on TrailList {\n  trails {\n    id\n    projectId\n    title\n    state\n  }\n}\n"
  }
};
})();

(node as any).hash = "8e2de72f56b4eae8d39ee8bb94a17bb3";

export default node;

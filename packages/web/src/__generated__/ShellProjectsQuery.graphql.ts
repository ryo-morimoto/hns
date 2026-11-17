/**
 * @generated SignedSource<<ba7e6214d67d2e6c07d533b1e04fda9b>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type QueryErrorCode = "INVALID_ARGUMENT" | "LIMIT_EXCEEDED" | "UNAVAILABLE" | "%future added value";
export type ShellProjectsQuery$variables = Record<PropertyKey, never>;
export type ShellProjectsQuery$data = {
  readonly projects: {
    readonly __typename: "ProjectList";
    readonly " $fragmentSpreads": FragmentRefs<"SidebarProjects">;
  } | {
    readonly __typename: "QueryFailure";
    readonly code: QueryErrorCode;
    readonly message: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type ShellProjectsQuery = {
  response: ShellProjectsQuery$data;
  variables: ShellProjectsQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "__typename",
  "storageKey": null
},
v1 = {
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
};
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "ShellProjectsQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": null,
        "kind": "LinkedField",
        "name": "projects",
        "plural": false,
        "selections": [
          (v0/*: any*/),
          {
            "kind": "InlineFragment",
            "selections": [
              {
                "args": null,
                "kind": "FragmentSpread",
                "name": "SidebarProjects"
              }
            ],
            "type": "ProjectList",
            "abstractKey": null
          },
          (v1/*: any*/)
        ],
        "storageKey": null
      }
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "ShellProjectsQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": null,
        "kind": "LinkedField",
        "name": "projects",
        "plural": false,
        "selections": [
          (v0/*: any*/),
          {
            "kind": "InlineFragment",
            "selections": [
              {
                "alias": null,
                "args": null,
                "concreteType": "Project",
                "kind": "LinkedField",
                "name": "projects",
                "plural": true,
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "id",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "name",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "workspaceRoot",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "agentCwd",
                    "storageKey": null
                  }
                ],
                "storageKey": null
              }
            ],
            "type": "ProjectList",
            "abstractKey": null
          },
          (v1/*: any*/)
        ],
        "storageKey": null
      }
    ]
  },
  "params": {
    "cacheID": "c18c1be210aec0efb6ff1bc7525e738f",
    "id": null,
    "metadata": {},
    "name": "ShellProjectsQuery",
    "operationKind": "query",
    "text": "query ShellProjectsQuery {\n  projects {\n    __typename\n    ... on ProjectList {\n      ...SidebarProjects\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n}\n\nfragment SidebarProjects on ProjectList {\n  projects {\n    id\n    name\n    workspaceRoot\n    agentCwd\n  }\n}\n"
  }
};
})();

(node as any).hash = "31dd582a94c5778b6715ebad963aabb8";

export default node;

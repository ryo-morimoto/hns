/**
 * @generated SignedSource<<e29e9b157fa3d1470fe5720090425c68>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type MutationFailureCode = "CONFLICT" | "FORBIDDEN" | "INVALID_REQUEST" | "LIMIT_EXCEEDED" | "NOT_FOUND" | "REVOKED" | "UNAVAILABLE" | "%future added value";
export type ReviewHunkInput = {
  changeId: string;
  expectedVersion: string;
  headStart: number;
  path: string;
};
export type TrailDetailKeepHunkMutation$variables = {
  input: ReviewHunkInput;
};
export type TrailDetailKeepHunkMutation$data = {
  readonly keepHunk: {
    readonly __typename: "MutationFailure";
    readonly code: MutationFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "ReviewHunkPayload";
    readonly diff: {
      readonly baseCommit: string;
      readonly headCommit: string;
    };
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type TrailDetailKeepHunkMutation = {
  response: TrailDetailKeepHunkMutation$data;
  variables: TrailDetailKeepHunkMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "input",
        "variableName": "input"
      }
    ],
    "concreteType": null,
    "kind": "LinkedField",
    "name": "keepHunk",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "__typename",
        "storageKey": null
      },
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "ReviewDiff",
            "kind": "LinkedField",
            "name": "diff",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "baseCommit",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "headCommit",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "type": "ReviewHunkPayload",
        "abstractKey": null
      },
      {
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
        "type": "MutationFailure",
        "abstractKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "TrailDetailKeepHunkMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "TrailDetailKeepHunkMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "495c1826eb21ed8003def493d10ca2d3",
    "id": null,
    "metadata": {},
    "name": "TrailDetailKeepHunkMutation",
    "operationKind": "mutation",
    "text": "mutation TrailDetailKeepHunkMutation(\n  $input: ReviewHunkInput!\n) {\n  keepHunk(input: $input) {\n    __typename\n    ... on ReviewHunkPayload {\n      diff {\n        baseCommit\n        headCommit\n      }\n    }\n    ... on MutationFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "d9bd595ff3f7cabcf4883f19916c3b33";

export default node;

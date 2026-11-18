/**
 * @generated SignedSource<<a70905836696b2a591f24f457d49e81a>>
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
export type TrailDetailUndoHunkMutation$variables = {
  input: ReviewHunkInput;
};
export type TrailDetailUndoHunkMutation$data = {
  readonly undoHunk: {
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
export type TrailDetailUndoHunkMutation = {
  response: TrailDetailUndoHunkMutation$data;
  variables: TrailDetailUndoHunkMutation$variables;
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
    "name": "undoHunk",
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
    "name": "TrailDetailUndoHunkMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "TrailDetailUndoHunkMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "de02a92ef2c56027cb6c497fea6f29dd",
    "id": null,
    "metadata": {},
    "name": "TrailDetailUndoHunkMutation",
    "operationKind": "mutation",
    "text": "mutation TrailDetailUndoHunkMutation(\n  $input: ReviewHunkInput!\n) {\n  undoHunk(input: $input) {\n    __typename\n    ... on ReviewHunkPayload {\n      diff {\n        baseCommit\n        headCommit\n      }\n    }\n    ... on MutationFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "f6222154811e7bede6133fc4ea3fdd5c";

export default node;

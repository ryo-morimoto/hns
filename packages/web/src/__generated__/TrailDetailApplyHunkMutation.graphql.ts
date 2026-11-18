/**
 * @generated SignedSource<<bad767566f209579dab3c8454de7b3e6>>
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
export type TrailDetailApplyHunkMutation$variables = {
  input: ReviewHunkInput;
};
export type TrailDetailApplyHunkMutation$data = {
  readonly applyHunk: {
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
export type TrailDetailApplyHunkMutation = {
  response: TrailDetailApplyHunkMutation$data;
  variables: TrailDetailApplyHunkMutation$variables;
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
    "name": "applyHunk",
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
    "name": "TrailDetailApplyHunkMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "TrailDetailApplyHunkMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "a5ccdce49d5080c6ae200265a4652702",
    "id": null,
    "metadata": {},
    "name": "TrailDetailApplyHunkMutation",
    "operationKind": "mutation",
    "text": "mutation TrailDetailApplyHunkMutation(\n  $input: ReviewHunkInput!\n) {\n  applyHunk(input: $input) {\n    __typename\n    ... on ReviewHunkPayload {\n      diff {\n        baseCommit\n        headCommit\n      }\n    }\n    ... on MutationFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "2236c74ac3e11dd9d4cbc41c097095dd";

export default node;

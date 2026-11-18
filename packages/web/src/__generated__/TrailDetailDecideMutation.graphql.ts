/**
 * @generated SignedSource<<0eb564513785a0914fcb28ab32a25546>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type MutationFailureCode = "CONFLICT" | "FORBIDDEN" | "INVALID_REQUEST" | "LIMIT_EXCEEDED" | "NOT_FOUND" | "REVOKED" | "UNAVAILABLE" | "%future added value";
export type TrailDecisionAction = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "%future added value";
export type TrailDecisionActionInput = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "%future added value";
export type DecideTrailInput = {
  action: TrailDecisionActionInput;
  changeId?: string | null | undefined;
  headCommit?: string | null | undefined;
  note?: string | null | undefined;
  resolveFindingIds?: ReadonlyArray<string | null | undefined> | null | undefined;
  trailId: string;
};
export type TrailDetailDecideMutation$variables = {
  input: DecideTrailInput;
};
export type TrailDetailDecideMutation$data = {
  readonly decideTrail: {
    readonly __typename: "DecideTrailPayload";
    readonly decision: {
      readonly action: TrailDecisionAction;
      readonly headCommit: string | null | undefined;
      readonly id: string;
    };
    readonly nextRunInput: string;
  } | {
    readonly __typename: "MutationFailure";
    readonly code: MutationFailureCode;
    readonly message: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type TrailDetailDecideMutation = {
  response: TrailDetailDecideMutation$data;
  variables: TrailDetailDecideMutation$variables;
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
    "name": "decideTrail",
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
            "concreteType": "TrailDecision",
            "kind": "LinkedField",
            "name": "decision",
            "plural": false,
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
                "name": "action",
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
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "nextRunInput",
            "storageKey": null
          }
        ],
        "type": "DecideTrailPayload",
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
    "name": "TrailDetailDecideMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "TrailDetailDecideMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "eed7615f8beb1196a8fd39bf3a179d7e",
    "id": null,
    "metadata": {},
    "name": "TrailDetailDecideMutation",
    "operationKind": "mutation",
    "text": "mutation TrailDetailDecideMutation(\n  $input: DecideTrailInput!\n) {\n  decideTrail(input: $input) {\n    __typename\n    ... on DecideTrailPayload {\n      decision {\n        id\n        action\n        headCommit\n      }\n      nextRunInput\n    }\n    ... on MutationFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "7286d094a56b6677ca02c32e504eb216";

export default node;

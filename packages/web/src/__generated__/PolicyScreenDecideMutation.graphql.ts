/**
 * @generated SignedSource<<2092297eb3d2083a1891948a0d551f85>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type PolicyFailureCode = "APPROVAL_STALE" | "INVALID_REQUEST" | "NOT_FOUND" | "POLICY_DENIED" | "UNSUPPORTED" | "%future added value";
export type PolicyProposalStatus = "APPROVED" | "PENDING" | "REJECTED" | "%future added value";
export type DecidePolicyInput = {
  approve: boolean;
  proposalId: string;
  reason: string;
  reviewToken: string;
};
export type PolicyScreenDecideMutation$variables = {
  input: DecidePolicyInput;
};
export type PolicyScreenDecideMutation$data = {
  readonly decidePolicy: {
    readonly __typename: "DecidePolicyPayload";
    readonly proposal: {
      readonly id: string;
      readonly status: PolicyProposalStatus;
    };
    readonly proposalStale: boolean;
    readonly revision: {
      readonly id: string;
      readonly revision: number;
    } | null | undefined;
  } | {
    readonly __typename: "PolicyFailure";
    readonly code: PolicyFailureCode;
    readonly message: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type PolicyScreenDecideMutation = {
  response: PolicyScreenDecideMutation$data;
  variables: PolicyScreenDecideMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
  }
],
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v2 = [
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
    "name": "decidePolicy",
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
            "concreteType": "PolicyProposal",
            "kind": "LinkedField",
            "name": "proposal",
            "plural": false,
            "selections": [
              (v1/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "status",
                "storageKey": null
              }
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "PolicyRevision",
            "kind": "LinkedField",
            "name": "revision",
            "plural": false,
            "selections": [
              (v1/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "revision",
                "storageKey": null
              }
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "proposalStale",
            "storageKey": null
          }
        ],
        "type": "DecidePolicyPayload",
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
        "type": "PolicyFailure",
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
    "name": "PolicyScreenDecideMutation",
    "selections": (v2/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "PolicyScreenDecideMutation",
    "selections": (v2/*: any*/)
  },
  "params": {
    "cacheID": "0d70056cef1888d7e23706ee3fa604bd",
    "id": null,
    "metadata": {},
    "name": "PolicyScreenDecideMutation",
    "operationKind": "mutation",
    "text": "mutation PolicyScreenDecideMutation(\n  $input: DecidePolicyInput!\n) {\n  decidePolicy(input: $input) {\n    __typename\n    ... on DecidePolicyPayload {\n      proposal {\n        id\n        status\n      }\n      revision {\n        id\n        revision\n      }\n      proposalStale\n    }\n    ... on PolicyFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "227671ac2903499fa81054034f627d6e";

export default node;

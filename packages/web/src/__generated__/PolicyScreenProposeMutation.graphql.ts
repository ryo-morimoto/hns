/**
 * @generated SignedSource<<1d3bbecf3baef6eec35eb6d3854478fe>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type PolicyFailureCode = "APPROVAL_STALE" | "INVALID_REQUEST" | "NOT_FOUND" | "POLICY_DENIED" | "UNSUPPORTED" | "%future added value";
export type PolicyProposalStatus = "APPROVED" | "PENDING" | "REJECTED" | "%future added value";
export type PolicyProposalInput = {
  bash: boolean;
  network: boolean;
  readRoots: ReadonlyArray<string>;
  reason: string;
  workspaceId: string;
  writeRoots: ReadonlyArray<string>;
};
export type PolicyScreenProposeMutation$variables = {
  input: PolicyProposalInput;
};
export type PolicyScreenProposeMutation$data = {
  readonly proposePolicy: {
    readonly __typename: "PolicyFailure";
    readonly code: PolicyFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "ProposePolicyPayload";
    readonly proposal: {
      readonly id: string;
      readonly status: PolicyProposalStatus;
    };
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type PolicyScreenProposeMutation = {
  response: PolicyScreenProposeMutation$data;
  variables: PolicyScreenProposeMutation$variables;
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
    "name": "proposePolicy",
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
                "name": "status",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "type": "ProposePolicyPayload",
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
    "name": "PolicyScreenProposeMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "PolicyScreenProposeMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "8eb8141c928656a5ed6ad5a877d717c7",
    "id": null,
    "metadata": {},
    "name": "PolicyScreenProposeMutation",
    "operationKind": "mutation",
    "text": "mutation PolicyScreenProposeMutation(\n  $input: PolicyProposalInput!\n) {\n  proposePolicy(input: $input) {\n    __typename\n    ... on ProposePolicyPayload {\n      proposal {\n        id\n        status\n      }\n    }\n    ... on PolicyFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "fe8624c1c9809b309ab7c209fc0b30e6";

export default node;

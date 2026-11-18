/**
 * @generated SignedSource<<52194d32d66e45616c8922cb150075f1>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type PolicyDiffKind = "EQUAL" | "EXPANSION" | "MIXED" | "NARROWING" | "UNSUPPORTED" | "%future added value";
export type PolicyFailureCode = "APPROVAL_STALE" | "INVALID_REQUEST" | "NOT_FOUND" | "POLICY_DENIED" | "UNSUPPORTED" | "%future added value";
export type PolicyProposalStatus = "APPROVED" | "PENDING" | "REJECTED" | "%future added value";
export type PolicyScreenQuery$variables = {
  workspaceId: string;
};
export type PolicyScreenQuery$data = {
  readonly policyProposals: {
    readonly __typename: "PolicyFailure";
    readonly code: PolicyFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "PolicyProposalList";
    readonly proposals: ReadonlyArray<{
      readonly baseRevision: number;
      readonly candidate: {
        readonly bash: boolean;
        readonly network: boolean;
        readonly readRoots: ReadonlyArray<string>;
        readonly writeRoots: ReadonlyArray<string>;
      };
      readonly createdAt: string;
      readonly diff: {
        readonly added: ReadonlyArray<{
          readonly atomKind: string;
          readonly value: string;
        }>;
        readonly kind: PolicyDiffKind;
        readonly removed: ReadonlyArray<{
          readonly atomKind: string;
          readonly value: string;
        }>;
      };
      readonly id: string;
      readonly reason: string;
      readonly requestedBy: string;
      readonly reviewToken: string;
      readonly status: PolicyProposalStatus;
    }>;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
  readonly policyRevisions: {
    readonly __typename: "PolicyFailure";
    readonly code: PolicyFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "PolicyRevisionList";
    readonly revisions: ReadonlyArray<{
      readonly active: boolean;
      readonly createdAt: string;
      readonly createdBy: string;
      readonly document: {
        readonly bash: boolean;
        readonly network: boolean;
        readonly readRoots: ReadonlyArray<string>;
        readonly writeRoots: ReadonlyArray<string>;
      };
      readonly hash: string;
      readonly id: string;
      readonly revision: number;
    }>;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type PolicyScreenQuery = {
  response: PolicyScreenQuery$data;
  variables: PolicyScreenQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "workspaceId"
  }
],
v1 = [
  {
    "kind": "Variable",
    "name": "workspaceId",
    "variableName": "workspaceId"
  }
],
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "__typename",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "createdAt",
  "storageKey": null
},
v5 = [
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "readRoots",
    "storageKey": null
  },
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "writeRoots",
    "storageKey": null
  },
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "bash",
    "storageKey": null
  },
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "network",
    "storageKey": null
  }
],
v6 = {
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
},
v7 = [
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "atomKind",
    "storageKey": null
  },
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "value",
    "storageKey": null
  }
],
v8 = [
  {
    "alias": null,
    "args": (v1/*: any*/),
    "concreteType": null,
    "kind": "LinkedField",
    "name": "policyRevisions",
    "plural": false,
    "selections": [
      (v2/*: any*/),
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "PolicyRevision",
            "kind": "LinkedField",
            "name": "revisions",
            "plural": true,
            "selections": [
              (v3/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "revision",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "hash",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "active",
                "storageKey": null
              },
              (v4/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "createdBy",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "concreteType": "PolicyDocument",
                "kind": "LinkedField",
                "name": "document",
                "plural": false,
                "selections": (v5/*: any*/),
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "type": "PolicyRevisionList",
        "abstractKey": null
      },
      (v6/*: any*/)
    ],
    "storageKey": null
  },
  {
    "alias": null,
    "args": (v1/*: any*/),
    "concreteType": null,
    "kind": "LinkedField",
    "name": "policyProposals",
    "plural": false,
    "selections": [
      (v2/*: any*/),
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "PolicyProposal",
            "kind": "LinkedField",
            "name": "proposals",
            "plural": true,
            "selections": [
              (v3/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "baseRevision",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "reviewToken",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "status",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "requestedBy",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "reason",
                "storageKey": null
              },
              (v4/*: any*/),
              {
                "alias": null,
                "args": null,
                "concreteType": "PolicyDocument",
                "kind": "LinkedField",
                "name": "candidate",
                "plural": false,
                "selections": (v5/*: any*/),
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "concreteType": "PolicyDiff",
                "kind": "LinkedField",
                "name": "diff",
                "plural": false,
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "kind",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "PolicyDiffAtom",
                    "kind": "LinkedField",
                    "name": "added",
                    "plural": true,
                    "selections": (v7/*: any*/),
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "PolicyDiffAtom",
                    "kind": "LinkedField",
                    "name": "removed",
                    "plural": true,
                    "selections": (v7/*: any*/),
                    "storageKey": null
                  }
                ],
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "type": "PolicyProposalList",
        "abstractKey": null
      },
      (v6/*: any*/)
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "PolicyScreenQuery",
    "selections": (v8/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "PolicyScreenQuery",
    "selections": (v8/*: any*/)
  },
  "params": {
    "cacheID": "29e291367811a9a3f18d1013b2e2ad76",
    "id": null,
    "metadata": {},
    "name": "PolicyScreenQuery",
    "operationKind": "query",
    "text": "query PolicyScreenQuery(\n  $workspaceId: ID!\n) {\n  policyRevisions(workspaceId: $workspaceId) {\n    __typename\n    ... on PolicyRevisionList {\n      revisions {\n        id\n        revision\n        hash\n        active\n        createdAt\n        createdBy\n        document {\n          readRoots\n          writeRoots\n          bash\n          network\n        }\n      }\n    }\n    ... on PolicyFailure {\n      code\n      message\n    }\n  }\n  policyProposals(workspaceId: $workspaceId) {\n    __typename\n    ... on PolicyProposalList {\n      proposals {\n        id\n        baseRevision\n        reviewToken\n        status\n        requestedBy\n        reason\n        createdAt\n        candidate {\n          readRoots\n          writeRoots\n          bash\n          network\n        }\n        diff {\n          kind\n          added {\n            atomKind\n            value\n          }\n          removed {\n            atomKind\n            value\n          }\n        }\n      }\n    }\n    ... on PolicyFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "a03075f34060079c6debc4e6430b9628";

export default node;

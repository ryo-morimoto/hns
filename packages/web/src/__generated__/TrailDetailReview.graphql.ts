/**
 * @generated SignedSource<<cd832354a36274f4dcceababd017cf0b>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
export type TrailChangeState = "ABANDONED" | "IN_REVIEW" | "MERGED" | "OPEN" | "%future added value";
export type TrailDecisionAction = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "%future added value";
export type TrailFindingSeverity = "HIGH" | "LOW" | "MEDIUM" | "NONE" | "%future added value";
export type TrailFindingSource = "AGENT" | "HUMAN" | "TEST" | "%future added value";
export type TrailFindingStatus = "DISMISSED" | "OPEN" | "RESOLVED" | "%future added value";
export type TrailGateKind = "FINDINGS" | "FRESHNESS" | "HUMAN_REVIEW" | "TESTS" | "%future added value";
export type TrailGateStatus = "ASK" | "FAIL" | "PASS" | "PENDING" | "%future added value";
export type TrailKind = "CHORE" | "FEATURE" | "FIX" | "SPIKE" | "%future added value";
export type TrailPriority = "HIGH" | "LOW" | "NORMAL" | "URGENT" | "%future added value";
export type TrailState = "ABANDONED" | "ACTIVE" | "CLOSED" | "DRAFT" | "IN_REVIEW" | "MERGED" | "OBSERVING" | "%future added value";
import { FragmentRefs } from "relay-runtime";
export type TrailDetailReview$data = {
  readonly acceptance: string;
  readonly changes: ReadonlyArray<{
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly id: string;
    readonly state: TrailChangeState;
    readonly " $fragmentSpreads": FragmentRefs<"TrailDetailChangeDiff">;
  }>;
  readonly decisions: ReadonlyArray<{
    readonly action: TrailDecisionAction;
    readonly actor: string;
    readonly at: string;
    readonly headCommit: string | null | undefined;
    readonly id: string;
    readonly note: string;
  }>;
  readonly description: string;
  readonly findings: ReadonlyArray<{
    readonly file: string | null | undefined;
    readonly hunk: string | null | undefined;
    readonly id: string;
    readonly severity: TrailFindingSeverity;
    readonly source: TrailFindingSource;
    readonly status: TrailFindingStatus;
    readonly summary: string;
  }>;
  readonly gates: {
    readonly line: string;
    readonly lines: ReadonlyArray<{
      readonly detail: string;
      readonly gate: TrailGateKind;
      readonly status: TrailGateStatus;
    }>;
  };
  readonly id: string;
  readonly kind: TrailKind;
  readonly priority: TrailPriority;
  readonly sessions: ReadonlyArray<{
    readonly conversationId: string | null | undefined;
    readonly id: string;
  }>;
  readonly state: TrailState;
  readonly title: string;
  readonly updatedAt: string;
  readonly " $fragmentType": "TrailDetailReview";
};
export type TrailDetailReview$key = {
  readonly " $data"?: TrailDetailReview$data;
  readonly " $fragmentSpreads": FragmentRefs<"TrailDetailReview">;
};

const node: ReaderFragment = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "state",
  "storageKey": null
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "headCommit",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "status",
  "storageKey": null
};
return {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "TrailDetailReview",
  "selections": [
    (v0/*: any*/),
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "title",
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "description",
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "acceptance",
      "storageKey": null
    },
    (v1/*: any*/),
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "priority",
      "storageKey": null
    },
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
      "kind": "ScalarField",
      "name": "updatedAt",
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": "TrailChange",
      "kind": "LinkedField",
      "name": "changes",
      "plural": true,
      "selections": [
        (v0/*: any*/),
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "baseCommit",
          "storageKey": null
        },
        (v2/*: any*/),
        (v1/*: any*/),
        {
          "args": null,
          "kind": "FragmentSpread",
          "name": "TrailDetailChangeDiff"
        }
      ],
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": "TrailFinding",
      "kind": "LinkedField",
      "name": "findings",
      "plural": true,
      "selections": [
        (v0/*: any*/),
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "severity",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "source",
          "storageKey": null
        },
        (v3/*: any*/),
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "file",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "hunk",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "summary",
          "storageKey": null
        }
      ],
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": "TrailDecision",
      "kind": "LinkedField",
      "name": "decisions",
      "plural": true,
      "selections": [
        (v0/*: any*/),
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
          "name": "actor",
          "storageKey": null
        },
        (v2/*: any*/),
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "note",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "at",
          "storageKey": null
        }
      ],
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": "TrailGates",
      "kind": "LinkedField",
      "name": "gates",
      "plural": false,
      "selections": [
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "line",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "concreteType": "TrailGateLine",
          "kind": "LinkedField",
          "name": "lines",
          "plural": true,
          "selections": [
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "gate",
              "storageKey": null
            },
            (v3/*: any*/),
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "detail",
              "storageKey": null
            }
          ],
          "storageKey": null
        }
      ],
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": "TrailSession",
      "kind": "LinkedField",
      "name": "sessions",
      "plural": true,
      "selections": [
        (v0/*: any*/),
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "conversationId",
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "type": "Trail",
  "abstractKey": null
};
})();

(node as any).hash = "ea0f08b6466cbf859d4ab1a63a3f5e6d";

export default node;

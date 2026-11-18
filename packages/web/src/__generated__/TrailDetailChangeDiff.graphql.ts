/**
 * @generated SignedSource<<1cb32e401b56b99b2814f5febf55a86d>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
export type QueryFailureCode = "INVALID_REQUEST" | "LIMIT_EXCEEDED" | "NOT_FOUND" | "UNAVAILABLE" | "%future added value";
export type ReviewChangeKind = "ADDED" | "DELETED" | "MODIFIED" | "%future added value";
export type ReviewLineKind = "ADD" | "CONTEXT" | "DEL" | "%future added value";
export type ReviewMirrorSide = "BASE" | "HEAD" | "%future added value";
export type ReviewMirrorStatus = "FAILED" | "MIRRORED" | "PENDING" | "SKIPPED" | "%future added value";
export type ReviewReadSource = "ARTIFACTS" | "MACHINE" | "R2" | "%future added value";
export type TrailChangeState = "ABANDONED" | "IN_REVIEW" | "MERGED" | "OPEN" | "%future added value";
import { FragmentRefs } from "relay-runtime";
export type TrailDetailChangeDiff$data = {
  readonly baseCommit: string;
  readonly diff: {
    readonly __typename: "QueryFailure";
    readonly code: QueryFailureCode;
    readonly message: string;
  } | {
    readonly __typename: "ReviewDiff";
    readonly added: number;
    readonly baseCommit: string;
    readonly fallback: string | null | undefined;
    readonly files: ReadonlyArray<{
      readonly added: number;
      readonly change: ReviewChangeKind;
      readonly hunks: ReadonlyArray<{
        readonly baseStart: number;
        readonly headStart: number;
        readonly lines: ReadonlyArray<{
          readonly kind: ReviewLineKind;
          readonly text: string;
        }>;
      }>;
      readonly path: string;
      readonly previewable: boolean;
      readonly removed: number;
    }>;
    readonly headCommit: string;
    readonly mirror: ReadonlyArray<{
      readonly commit: string;
      readonly failure: string | null | undefined;
      readonly side: ReviewMirrorSide;
      readonly source: ReviewReadSource;
      readonly status: ReviewMirrorStatus;
    }>;
    readonly removed: number;
    readonly source: ReviewReadSource;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
  readonly headCommit: string;
  readonly id: string;
  readonly state: TrailChangeState;
  readonly " $fragmentType": "TrailDetailChangeDiff";
};
export type TrailDetailChangeDiff$key = {
  readonly " $data"?: TrailDetailChangeDiff$data;
  readonly " $fragmentSpreads": FragmentRefs<"TrailDetailChangeDiff">;
};

const node: ReaderFragment = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "baseCommit",
  "storageKey": null
},
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "headCommit",
  "storageKey": null
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "added",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "removed",
  "storageKey": null
},
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "source",
  "storageKey": null
};
return {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "TrailDetailChangeDiff",
  "selections": [
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "id",
      "storageKey": null
    },
    (v0/*: any*/),
    (v1/*: any*/),
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "state",
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": null,
      "kind": "LinkedField",
      "name": "diff",
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
            (v0/*: any*/),
            (v1/*: any*/),
            (v2/*: any*/),
            (v3/*: any*/),
            (v4/*: any*/),
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "fallback",
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "concreteType": "ReviewMirror",
              "kind": "LinkedField",
              "name": "mirror",
              "plural": true,
              "selections": [
                {
                  "alias": null,
                  "args": null,
                  "kind": "ScalarField",
                  "name": "side",
                  "storageKey": null
                },
                {
                  "alias": null,
                  "args": null,
                  "kind": "ScalarField",
                  "name": "commit",
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
                  "name": "failure",
                  "storageKey": null
                },
                (v4/*: any*/)
              ],
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "concreteType": "ReviewFile",
              "kind": "LinkedField",
              "name": "files",
              "plural": true,
              "selections": [
                {
                  "alias": null,
                  "args": null,
                  "kind": "ScalarField",
                  "name": "path",
                  "storageKey": null
                },
                {
                  "alias": null,
                  "args": null,
                  "kind": "ScalarField",
                  "name": "change",
                  "storageKey": null
                },
                (v2/*: any*/),
                (v3/*: any*/),
                {
                  "alias": null,
                  "args": null,
                  "kind": "ScalarField",
                  "name": "previewable",
                  "storageKey": null
                },
                {
                  "alias": null,
                  "args": null,
                  "concreteType": "ReviewHunk",
                  "kind": "LinkedField",
                  "name": "hunks",
                  "plural": true,
                  "selections": [
                    {
                      "alias": null,
                      "args": null,
                      "kind": "ScalarField",
                      "name": "baseStart",
                      "storageKey": null
                    },
                    {
                      "alias": null,
                      "args": null,
                      "kind": "ScalarField",
                      "name": "headStart",
                      "storageKey": null
                    },
                    {
                      "alias": null,
                      "args": null,
                      "concreteType": "ReviewLine",
                      "kind": "LinkedField",
                      "name": "lines",
                      "plural": true,
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
                          "kind": "ScalarField",
                          "name": "text",
                          "storageKey": null
                        }
                      ],
                      "storageKey": null
                    }
                  ],
                  "storageKey": null
                }
              ],
              "storageKey": null
            }
          ],
          "type": "ReviewDiff",
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
          "type": "QueryFailure",
          "abstractKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "type": "TrailChange",
  "abstractKey": null
};
})();

(node as any).hash = "2a4f4b30d68cb04cd747fcc633b88d8e";

export default node;

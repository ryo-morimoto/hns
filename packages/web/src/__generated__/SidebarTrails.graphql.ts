/**
 * @generated SignedSource<<159cd7dda90ebf5d222b282ea63bcc98>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
export type TrailState = "ABANDONED" | "ACTIVE" | "CLOSED" | "DRAFT" | "IN_REVIEW" | "MERGED" | "OBSERVING" | "%future added value";
import { FragmentRefs } from "relay-runtime";
export type SidebarTrails$data = {
  readonly trails: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly state: TrailState;
    readonly title: string;
  }>;
  readonly " $fragmentType": "SidebarTrails";
};
export type SidebarTrails$key = {
  readonly " $data"?: SidebarTrails$data;
  readonly " $fragmentSpreads": FragmentRefs<"SidebarTrails">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "SidebarTrails",
  "selections": [
    {
      "alias": null,
      "args": null,
      "concreteType": "Trail",
      "kind": "LinkedField",
      "name": "trails",
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
          "name": "projectId",
          "storageKey": null
        },
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
          "name": "state",
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "type": "TrailList",
  "abstractKey": null
};

(node as any).hash = "cbef6597a91fd2b4dbf40522132e2e71";

export default node;

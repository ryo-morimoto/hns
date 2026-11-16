/**
 * @generated SignedSource<<c09a2199e99bf9dd642e27eac414c821>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type SidebarProjects$data = {
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly " $fragmentType": "SidebarProjects";
};
export type SidebarProjects$key = {
  readonly " $data"?: SidebarProjects$data;
  readonly " $fragmentSpreads": FragmentRefs<"SidebarProjects">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "SidebarProjects",
  "selections": [
    {
      "alias": null,
      "args": null,
      "concreteType": "Project",
      "kind": "LinkedField",
      "name": "projects",
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
          "name": "name",
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "type": "ProjectList",
  "abstractKey": null
};

(node as any).hash = "d34859ba284bc80e41ed9a278f64d086";

export default node;

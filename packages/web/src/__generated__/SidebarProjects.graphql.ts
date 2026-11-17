/**
 * @generated SignedSource<<34bb1be5e5c53d95abb64dece57d7ddd>>
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
    readonly agentCwd: string;
    readonly id: string;
    readonly name: string;
    readonly workspaceRoot: string;
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
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "workspaceRoot",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "agentCwd",
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "type": "ProjectList",
  "abstractKey": null
};

(node as any).hash = "b7896808dad779185ba71a1213e319ac";

export default node;

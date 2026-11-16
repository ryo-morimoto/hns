/**
 * @generated SignedSource<<c23b4c5d9c93be36ad821878153632df>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
export type TaskStatus = "BLOCKED" | "DOING" | "DONE" | "TODO" | "%future added value";
import { FragmentRefs } from "relay-runtime";
export type SidebarTasks$data = {
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly status: TaskStatus;
    readonly title: string;
  }>;
  readonly " $fragmentType": "SidebarTasks";
};
export type SidebarTasks$key = {
  readonly " $data"?: SidebarTasks$data;
  readonly " $fragmentSpreads": FragmentRefs<"SidebarTasks">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "SidebarTasks",
  "selections": [
    {
      "alias": null,
      "args": null,
      "concreteType": "Task",
      "kind": "LinkedField",
      "name": "tasks",
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
          "name": "title",
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
  "type": "TaskList",
  "abstractKey": null
};

(node as any).hash = "aeea115d3d1e7b26b4755bd1ef41602c";

export default node;

/**
 * @generated SignedSource<<35fe8f4781608d607270b956523ae43c>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type SidebarConversations$data = {
  readonly conversations: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
  }>;
  readonly " $fragmentType": "SidebarConversations";
};
export type SidebarConversations$key = {
  readonly " $data"?: SidebarConversations$data;
  readonly " $fragmentSpreads": FragmentRefs<"SidebarConversations">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "SidebarConversations",
  "selections": [
    {
      "alias": null,
      "args": null,
      "concreteType": "Conversation",
      "kind": "LinkedField",
      "name": "conversations",
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
        }
      ],
      "storageKey": null
    }
  ],
  "type": "ConversationList",
  "abstractKey": null
};

(node as any).hash = "d4c6c102e4f739070d24043467b8a50a";

export default node;

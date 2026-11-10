/**
 * @generated SignedSource<<9e740a4e360e6cda4f65457638d23205>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* eslint-disable */

'use strict';

var node = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "projectId"
  }
],
v1 = [
  {
    "kind": "Variable",
    "name": "projectId",
    "variableName": "projectId"
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "SidebarQuery",
    "selections": [
      {
        "alias": null,
        "args": (v1/*: any*/),
        "concreteType": "Conversation",
        "kind": "LinkedField",
        "name": "conversations",
        "plural": true,
        "selections": [
          {
            "args": null,
            "kind": "FragmentSpread",
            "name": "Sidebar_conversation"
          }
        ],
        "storageKey": null
      }
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "SidebarQuery",
    "selections": [
      {
        "alias": null,
        "args": (v1/*: any*/),
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
            "name": "title",
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
            "kind": "ScalarField",
            "name": "archived",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ]
  },
  "params": {
    "cacheID": "ba55d315ef844dc9b41a3689af036ce0",
    "id": null,
    "metadata": {},
    "name": "SidebarQuery",
    "operationKind": "query",
    "text": "query SidebarQuery(\n  $projectId: ID\n) {\n  conversations(projectId: $projectId) {\n    ...Sidebar_conversation\n    id\n  }\n}\n\nfragment Sidebar_conversation on Conversation {\n  id\n  title\n  updatedAt\n  archived\n}\n"
  }
};
})();

node.hash = "1200f586e347dc1de4bf249b2e332cca";

export default node;

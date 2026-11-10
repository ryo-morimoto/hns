/**
 * @generated SignedSource<<43c38aa30396752ddcf20c9946ecc74f>>
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
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "projectId",
        "variableName": "projectId"
      }
    ],
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
        "concreteType": "Live",
        "kind": "LinkedField",
        "name": "live",
        "plural": false,
        "selections": [
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
            "name": "needsReason",
            "storageKey": null
          }
        ],
        "storageKey": null
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
    "name": "PanelQuery",
    "selections": (v1/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "PanelQuery",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "aa84dd645ba5d409bf1cf327d103f1e3",
    "id": null,
    "metadata": {},
    "name": "PanelQuery",
    "operationKind": "query",
    "text": "query PanelQuery(\n  $projectId: ID\n) {\n  conversations(projectId: $projectId) {\n    id\n    title\n    live {\n      status\n      needsReason\n    }\n  }\n}\n"
  }
};
})();

node.hash = "501c34c7d77d6965ed3873f96c073f58";

export default node;

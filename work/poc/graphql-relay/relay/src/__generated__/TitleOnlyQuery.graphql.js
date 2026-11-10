/**
 * @generated SignedSource<<c322f150be9e63222579bc4050850e1b>>
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
    "name": "TitleOnlyQuery",
    "selections": (v1/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "TitleOnlyQuery",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "347ab8a5e92165202418676074ee4b8c",
    "id": null,
    "metadata": {},
    "name": "TitleOnlyQuery",
    "operationKind": "query",
    "text": "query TitleOnlyQuery(\n  $projectId: ID\n) {\n  conversations(projectId: $projectId) {\n    id\n    title\n  }\n}\n"
  }
};
})();

node.hash = "1c5597cdea400c1eea68ecb7809e133c";

export default node;

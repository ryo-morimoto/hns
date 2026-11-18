/**
 * @generated SignedSource<<bb5687c72d772f8954fb65abad2d5e2c>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type OfficeErrorCode = "CANCELLED" | "ENGINE_BUSY" | "ENGINE_FAILED" | "ENGINE_TIMEOUT" | "ENGINE_UNAVAILABLE" | "INPUT_TOO_LARGE" | "INPUT_TOO_LARGE_ARCHIVE" | "NOT_AUTHORIZED" | "OUTPUT_TOO_LARGE" | "SOURCE_CHANGED" | "TOO_MANY_CELLS" | "TOO_MANY_PAGES" | "TOO_MANY_PIXELS" | "UNSUPPORTED_COMMAND" | "UNSUPPORTED_FORMAT" | "%future added value";
export type DocumentPanelEngineQuery$variables = Record<PropertyKey, never>;
export type DocumentPanelEngineQuery$data = {
  readonly officeEngine: {
    readonly __typename: "OfficeEngineAvailable";
    readonly id: string;
    readonly version: string;
  } | {
    readonly __typename: "OfficeEngineUnavailable";
    readonly reason: string;
  } | {
    readonly __typename: "OfficeFailure";
    readonly code: OfficeErrorCode;
    readonly message: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type DocumentPanelEngineQuery = {
  response: DocumentPanelEngineQuery$data;
  variables: DocumentPanelEngineQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": null,
    "kind": "LinkedField",
    "name": "officeEngine",
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
            "name": "version",
            "storageKey": null
          }
        ],
        "type": "OfficeEngineAvailable",
        "abstractKey": null
      },
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "reason",
            "storageKey": null
          }
        ],
        "type": "OfficeEngineUnavailable",
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
        "type": "OfficeFailure",
        "abstractKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "DocumentPanelEngineQuery",
    "selections": (v0/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "DocumentPanelEngineQuery",
    "selections": (v0/*: any*/)
  },
  "params": {
    "cacheID": "fb817e32c509a807dec7c453daeb151f",
    "id": null,
    "metadata": {},
    "name": "DocumentPanelEngineQuery",
    "operationKind": "query",
    "text": "query DocumentPanelEngineQuery {\n  officeEngine {\n    __typename\n    ... on OfficeEngineAvailable {\n      id\n      version\n    }\n    ... on OfficeEngineUnavailable {\n      reason\n    }\n    ... on OfficeFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "581445635c75ebe9d874fcd3222f91b5";

export default node;

/**
 * @generated SignedSource<<eb20d64606bc8438b09ad094fc7a558c>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type OfficeErrorCode = "CANCELLED" | "ENGINE_BUSY" | "ENGINE_FAILED" | "ENGINE_TIMEOUT" | "ENGINE_UNAVAILABLE" | "INPUT_TOO_LARGE" | "INPUT_TOO_LARGE_ARCHIVE" | "NOT_AUTHORIZED" | "OUTPUT_TOO_LARGE" | "SOURCE_CHANGED" | "TOO_MANY_CELLS" | "TOO_MANY_PAGES" | "TOO_MANY_PIXELS" | "UNSUPPORTED_COMMAND" | "UNSUPPORTED_FORMAT" | "%future added value";
export type PreviewStatus = "DISABLED" | "FAILED" | "GENERATING" | "QUEUED" | "READY" | "STALE" | "UNSUPPORTED" | "%future added value";
export type DocumentPanelQuery$variables = {
  path: string;
  workspaceId: string;
};
export type DocumentPanelQuery$data = {
  readonly documentPreview: {
    readonly __typename: "DocumentPreview";
    readonly bytes: number | null | undefined;
    readonly error: {
      readonly code: OfficeErrorCode;
      readonly message: string;
    } | null | undefined;
    readonly pages: number | null | undefined;
    readonly status: PreviewStatus;
    readonly url: string | null | undefined;
    readonly version: string;
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
export type DocumentPanelQuery = {
  response: DocumentPanelQuery$data;
  variables: DocumentPanelQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "path"
  },
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "workspaceId"
  }
],
v1 = [
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
v2 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "path",
        "variableName": "path"
      },
      {
        "kind": "Variable",
        "name": "workspaceId",
        "variableName": "workspaceId"
      }
    ],
    "concreteType": null,
    "kind": "LinkedField",
    "name": "documentPreview",
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
            "name": "status",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "url",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "pages",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "bytes",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "version",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "OfficeFailure",
            "kind": "LinkedField",
            "name": "error",
            "plural": false,
            "selections": (v1/*: any*/),
            "storageKey": null
          }
        ],
        "type": "DocumentPreview",
        "abstractKey": null
      },
      {
        "kind": "InlineFragment",
        "selections": (v1/*: any*/),
        "type": "OfficeFailure",
        "abstractKey": null
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
    "name": "DocumentPanelQuery",
    "selections": (v2/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "DocumentPanelQuery",
    "selections": (v2/*: any*/)
  },
  "params": {
    "cacheID": "ad0b41874731e5a90bf18f86aba38595",
    "id": null,
    "metadata": {},
    "name": "DocumentPanelQuery",
    "operationKind": "query",
    "text": "query DocumentPanelQuery(\n  $path: String!\n  $workspaceId: String!\n) {\n  documentPreview(path: $path, workspaceId: $workspaceId) {\n    __typename\n    ... on DocumentPreview {\n      status\n      url\n      pages\n      bytes\n      version\n      error {\n        code\n        message\n      }\n    }\n    ... on OfficeFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "405afa72b59790f60c416a826aeff94c";

export default node;

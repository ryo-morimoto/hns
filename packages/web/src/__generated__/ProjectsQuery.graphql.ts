/**
 * @generated SignedSource<<46a74e09da025bff09bb63544217045d>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type QueryErrorCode = "INVALID_ARGUMENT" | "LIMIT_EXCEEDED" | "UNAVAILABLE" | "%future added value";
export type ProjectsQuery$variables = Record<PropertyKey, never>;
export type ProjectsQuery$data = {
  readonly projects: {
    readonly __typename: "ProjectList";
    readonly projects: ReadonlyArray<{
      readonly createdAt: string;
      readonly id: string;
      readonly name: string;
    }>;
  } | {
    readonly __typename: "QueryFailure";
    readonly code: QueryErrorCode;
    readonly message: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type ProjectsQuery = {
  response: ProjectsQuery$data;
  variables: ProjectsQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": null,
    "kind": "LinkedField",
    "name": "projects",
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
                "name": "createdAt",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "type": "ProjectList",
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
        "type": "QueryFailure",
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
    "name": "ProjectsQuery",
    "selections": (v0/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "ProjectsQuery",
    "selections": (v0/*: any*/)
  },
  "params": {
    "cacheID": "962c3c9e25e8dcf9a000ec45151377d8",
    "id": null,
    "metadata": {},
    "name": "ProjectsQuery",
    "operationKind": "query",
    "text": "query ProjectsQuery {\n  projects {\n    __typename\n    ... on ProjectList {\n      projects {\n        id\n        name\n        createdAt\n      }\n    }\n    ... on QueryFailure {\n      code\n      message\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "e3069bfe4017badebe920f8883eef39c";

export default node;

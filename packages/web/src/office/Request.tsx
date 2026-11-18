import { useCallback } from "react";
import { graphql } from "react-relay";
import { commitMutation } from "relay-runtime";
import { useRelayEnvironment } from "react-relay";
import type { RequestMutation } from "../__generated__/RequestMutation.graphql";

/**
 * The panel's request: one row and an alarm, answered at once.
 *
 * @remarks
 * The workspace is an argument, not a variable the caller may omit: the server reads an absent
 * `workspaceId` as a workspace it does not know and answers `not_authorized` (fail closed), so
 * the panel always sends the project the Sidebar selected.
 */
const RequestOperation = graphql`
  mutation RequestMutation($path: String!, $workspaceId: String!) {
    requestDocumentPreview(path: $path, workspaceId: $workspaceId) {
      __typename
      ... on DocumentPreview {
        status
        url
        pages
        bytes
        version
        error {
          code
          message
        }
      }
      ... on OfficeFailure {
        code
        message
      }
    }
  }
`;

/**
 * One preview row as the request answers it.
 *
 * @remarks
 * The mutation and the panel's read select the same fields of the same union, so a row the request
 * answers with is a row the panel can draw; the type is named on the mutation's side because this
 * module owns the mutation.
 */
export type PreviewRow = NonNullable<RequestMutation["response"]["requestDocumentPreview"]> & {
  readonly __typename: "DocumentPreview";
};

/** What the request answered: the row it wrote or reused, or the code it refused with. */
export type RequestAnswer =
  | { readonly ok: true; readonly row: PreviewRow }
  /** The code the server refused with, lowercased as the contract spells it; a member this build
   * does not know yet is passed through and drawn as any other failure. */
  | { readonly ok: false; readonly code: string };

/** An answer that never reached the server. */
const NO_ANSWER: RequestAnswer = { ok: false, code: "engine_unavailable" };

/** One answered row as the panel's row. */
function rowOf(
  value: NonNullable<RequestMutation["response"]["requestDocumentPreview"]>,
): PreviewRow {
  // SAFETY: both operations select the same fields of the same union member (status, url, pages,
  // bytes, version, error); the mutation's type is the panel's row plus nothing else.
  return value as PreviewRow;
}

/**
 * Read one mutation answer as the panel's value.
 *
 * @param value - The union member the mutation answered, or null for no answer at all.
 * @returns The row, or the failure's code.
 *
 * @remarks
 * A null answer is the network: the request did not reach the server. It is drawn as
 * `engine_unavailable` because the row was never asked for, not because a job failed — the same
 * reading the contract forces on a read that found no row.
 */
function requestAnswerOf(
  value: RequestMutation["response"]["requestDocumentPreview"],
): RequestAnswer {
  if (value === null) return NO_ANSWER;
  if (value.__typename === "DocumentPreview") return { ok: true, row: rowOf(value) };
  if (value.__typename === "OfficeFailure") return { ok: false, code: value.code.toLowerCase() };
  // The schema is closed; a member this build does not know is a contract it has outgrown.
  return NO_ANSWER;
}

/**
 * The panel's request, as a promise of the panel's value.
 *
 * @returns A function that asks for one file's preview and resolves with the answer.
 *
 * @remarks
 * `commitMutation`, not `useMutation`: the answer is a value this component draws from its own
 * state, and Relay's hook form keeps a commit's callbacks on the hook instance, which a component
 * that unmounts between the commit and its answer (a poll keyed on the read counter does exactly
 * that) would drop. A commit made from the environment delivers its answer whoever is mounted.
 */
export function useDocumentRequest(): (input: {
  readonly workspaceId: string;
  readonly path: string;
}) => Promise<RequestAnswer> {
  const environment = useRelayEnvironment();
  // A stable function: the panel's request effect depends on it, and a new closure per render
  // would re-run the effect (and re-ask) on every render.
  return useCallback(
    (input: { readonly workspaceId: string; readonly path: string }) =>
      new Promise<RequestAnswer>((resolve) => {
        try {
          commitMutation<RequestMutation>(environment, {
            mutation: RequestOperation,
            variables: { workspaceId: input.workspaceId, path: input.path },
            onCompleted: (response) => {
              resolve(requestAnswerOf(response.requestDocumentPreview));
            },
            onError: () => {
              resolve(NO_ANSWER);
            },
          });
        } catch {
          // A commit the environment refuses (a destroyed store) is not a network answer either.
          resolve(NO_ANSWER);
        }
      }),
    [environment],
  );
}

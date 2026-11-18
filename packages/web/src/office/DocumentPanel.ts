import { graphql } from "react-relay";

/**
 * The document panel's read: one file's preview row, or the failure that says why there is none.
 *
 * @remarks
 * `workspaceId` is always sent (the Sidebar's selected project): the field treats it as the
 * workspace the read acts in, so leaving it out is a read this panel cannot make.
 *
 * The failure member carries the contract's code and the server's message; the panel shows the
 * code's own sentence and never the message (that one is written for an operator).
 */
export const DocumentPanelQuery = graphql`
  query DocumentPanelQuery($path: String!, $workspaceId: String!) {
    documentPreview(path: $path, workspaceId: $workspaceId) {
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
 * The engine, for the "not set up" state's diagnosis: the engine, why there is none, or a failure.
 *
 * @remarks
 * The probe names no workspace: it is a diagnosis of the deployment, not of one file, and the
 * server reads an absent `workspaceId` as the session's own project.
 */
export const DocumentPanelEngineQuery = graphql`
  query DocumentPanelEngineQuery {
    officeEngine {
      __typename
      ... on OfficeEngineAvailable {
        id
        version
      }
      ... on OfficeEngineUnavailable {
        reason
      }
      ... on OfficeFailure {
        code
        message
      }
    }
  }
`;

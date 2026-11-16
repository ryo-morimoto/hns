import { graphql } from "react-relay";

/**
 * The selected project's conversations and tasks.
 *
 * @remarks
 * When no project is selected the two fields are skipped and Relay sends no request at all, so
 * the screen costs no Session RPC. The argument is non-null, so the caller still builds a
 * sentinel id; it never reaches the wire.
 */
export const ShellWorkspaceQuery = graphql`
  query ShellWorkspaceQuery($projectId: ID!, $hasProject: Boolean!) {
    conversations(projectId: $projectId) @include(if: $hasProject) {
      __typename
      ... on ConversationList {
        ...SidebarConversations
      }
      ... on QueryFailure {
        code
        message
      }
    }
    tasks(projectId: $projectId) @include(if: $hasProject) {
      __typename
      ... on TaskList {
        ...SidebarTasks
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

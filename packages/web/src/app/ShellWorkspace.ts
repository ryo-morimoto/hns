import { graphql } from "react-relay";

/**
 * The selected project's conversations and tasks.
 *
 * @remarks
 * When no project is selected the two fields are skipped, so the screen costs no Session RPC.
 * `projectId` is still sent because the argument is non-null; it is never read when skipped.
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

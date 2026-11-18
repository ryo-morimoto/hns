import { graphql } from "react-relay";

/**
 * The selected project's conversations and Trails.
 *
 * @remarks
 * When no project is selected the two fields are skipped and Relay sends no request at all, so
 * the screen costs no Session RPC. The argument is non-null, so the caller still builds a
 * sentinel id; it never reaches the wire.
 *
 * `trails` is the selected project's list, not every project's: the Sidebar groups the workspace
 * it is looking at, and the "All workspaces" summary above it is a separate read. The `trails`
 * field takes `projectId` optionally, so a request that omits it asks for every project; this
 * document always names one.
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
    trails(projectId: $projectId) @include(if: $hasProject) {
      __typename
      ... on TrailList {
        ...SidebarTrails
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

import { graphql } from "react-relay";

/** The conversations and tasks of one project; both reads come from their own resolver. */
export const WorkspaceQuery = graphql`
  query WorkspaceQuery($projectId: ID!) {
    conversations(projectId: $projectId) {
      __typename
      ... on ConversationList {
        conversations {
          id
          projectId
          title
          createdAt
          updatedAt
          isArchived
          deletedAt
        }
      }
      ... on QueryFailure {
        code
        message
      }
    }
    tasks(projectId: $projectId) {
      __typename
      ... on TaskList {
        tasks {
          id
          projectId
          title
          status
          createdAt
          updatedAt
        }
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

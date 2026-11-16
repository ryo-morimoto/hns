import { graphql } from "react-relay";

/** The workspace list the shell picks its default project from. */
export const ProjectsQuery = graphql`
  query ProjectsQuery {
    projects {
      __typename
      ... on ProjectList {
        projects {
          id
          name
          createdAt
        }
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

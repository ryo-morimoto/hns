import { graphql } from "react-relay";

/** The workspace list the shell picks its default project from. */
export const ShellProjectsQuery = graphql`
  query ShellProjectsQuery {
    projects {
      __typename
      ... on ProjectList {
        ...SidebarProjects
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

import { graphql } from "relay-runtime";

// A third screen that only needs fields the sidebar already fetched.
export const TitleOnlyQuery = graphql`
  query TitleOnlyQuery($projectId: ID) {
    conversations(projectId: $projectId) {
      id
      title
    }
  }
`;

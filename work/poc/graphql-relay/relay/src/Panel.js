import { graphql } from "relay-runtime";

// A second screen that needs the live fields of the same rows the sidebar shows.
export const PanelQuery = graphql`
  query PanelQuery($projectId: ID) {
    conversations(projectId: $projectId) {
      id
      title
      live {
        status
        needsReason
      }
    }
  }
`;

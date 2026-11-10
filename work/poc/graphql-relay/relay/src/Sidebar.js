import { graphql } from "relay-runtime";

// The sidebar asks for exactly the four fields it renders.
export const SidebarQuery = graphql`
  query SidebarQuery($projectId: ID) {
    conversations(projectId: $projectId) {
      ...Sidebar_conversation
    }
  }
`;

export const SidebarFragment = graphql`
  fragment Sidebar_conversation on Conversation {
    id
    title
    updatedAt
    archived
  }
`;

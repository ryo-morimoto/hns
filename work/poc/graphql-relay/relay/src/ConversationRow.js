import { graphql } from "relay-runtime";

// What one row renders. If this entity gains a field the row needs, this is the
// only file that changes — and the compiler checks the store can serve it.
export const ConversationRowFragment = graphql`
  fragment ConversationRow_conversation on Conversation {
    id
    title
    live {
      status
      needsReason
    }
  }
`;

import { graphql } from "relay-runtime";

export const OverviewQuery = graphql`
  query OverviewQuery {
    overview {
      counts {
        needsYou
        running
        doneToday
      }
      needs {
        ...OverviewItem_item
      }
      running {
        ...OverviewItem_item
      }
    }
  }
`;

export const OverviewItemFragment = graphql`
  fragment OverviewItem_item on Item {
    kind
    id
    title
    reason
    updatedAt
  }
`;

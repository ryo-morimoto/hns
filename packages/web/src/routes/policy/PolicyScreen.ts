import { graphql } from "react-relay";

/**
 * The policy screen's read: the workspace's revisions (with the active one) and its proposals.
 *
 * @remarks
 * One document, one request: the screen shows "what is allowed now" and "what would change"
 * together, and two reads could render the second beside a first that a decision already moved
 * (the approval switches the active revision). The proposals are asked for every status so a
 * decision's result is visible without a second document; the screen keeps the pending ones.
 *
 * `reviewToken` is selected because an approval must name the proposal as it was read: the
 * service recomputes the token and answers `approval_stale` when the stored proposal has moved.
 */
export const PolicyScreenQuery = graphql`
  query PolicyScreenQuery($workspaceId: ID!) {
    policyRevisions(workspaceId: $workspaceId) {
      __typename
      ... on PolicyRevisionList {
        revisions {
          id
          revision
          hash
          active
          createdAt
          createdBy
          document {
            readRoots
            writeRoots
            bash
            network
          }
        }
      }
      ... on PolicyFailure {
        code
        message
      }
    }
    policyProposals(workspaceId: $workspaceId) {
      __typename
      ... on PolicyProposalList {
        proposals {
          id
          baseRevision
          reviewToken
          status
          requestedBy
          reason
          createdAt
          candidate {
            readRoots
            writeRoots
            bash
            network
          }
          diff {
            kind
            added {
              atomKind
              value
            }
            removed {
              atomKind
              value
            }
          }
        }
      }
      ... on PolicyFailure {
        code
        message
      }
    }
  }
`;

/**
 * Ask for a revision; a human decides it.
 *
 * @remarks
 * The token is the one the screen displayed, never a freshly read one: an approval that quietly
 * refreshes its token would approve a proposal the human did not read. A stale answer is shown,
 * and the human reloads.
 */
export const DecidePolicyProposalMutation = graphql`
  mutation PolicyScreenDecideMutation($input: DecidePolicyInput!) {
    decidePolicy(input: $input) {
      __typename
      ... on DecidePolicyPayload {
        proposal {
          id
          status
        }
        revision {
          id
          revision
        }
        proposalStale
      }
      ... on PolicyFailure {
        code
        message
      }
    }
  }
`;

/**
 * Propose a change; any principal may, and it changes nothing until a human decides.
 *
 * @remarks
 * `readRoots` / `writeRoots` are the roots the proposer names, and **an empty list means
 * "unchanged"**: the face keeps the active revision's roots for that tool. The screen sends what
 * the form has, so a form left empty asks for nothing on that axis.
 */
export const ProposePolicyMutation = graphql`
  mutation PolicyScreenProposeMutation($input: PolicyProposalInput!) {
    proposePolicy(input: $input) {
      __typename
      ... on ProposePolicyPayload {
        proposal {
          id
          status
        }
      }
      ... on PolicyFailure {
        code
        message
      }
    }
  }
`;

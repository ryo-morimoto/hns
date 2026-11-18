import { graphql } from "react-relay";

/**
 * The review face's read (0232): one Trail with what a reviewer decides on.
 *
 * @remarks
 * **Order is the reading order, and it is deliberate**: the intent, then the change, then what is
 * unresolved, then the gates, then the diff — the diff and the open points come before anything
 * about the process (`run review sheet` §4.4: the process is not the main character). The change's
 * diff is read **per Change** ({@link TrailDetailChangeDiffFragment}), so files, hunks, and lines come
 * from the checkpoint diff engine (`ReviewDiff`), not from the browser.
 *
 * `findings` and `decisions` are read in full (newest first); the screen shows blocking findings
 * by default. `gates` is the server's computed evaluation and `gates.line` its one-line verdict.
 */
export const TrailDetailQuery = graphql`
  query TrailDetailQuery($id: ID!) {
    trail(id: $id) {
      __typename
      ... on TrailPayload {
        trail {
          ...TrailDetailReview
        }
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

/**
 * One Trail as the review face renders it.
 *
 * @remarks
 * The fragment is spread into the query, so after a decision the screen re-reads one record and the
 * gate line, the findings, and the approval sentence all move together (D077: the server's answer
 * is what is shown, not the mutation's echo).
 */
export const TrailDetailReviewFragment = graphql`
  fragment TrailDetailReview on Trail {
    id
    title
    description
    acceptance
    state
    priority
    kind
    updatedAt
    changes {
      id
      baseCommit
      headCommit
      state
      ...TrailDetailChangeDiff
    }
    findings {
      id
      severity
      source
      status
      file
      hunk
      summary
    }
    decisions {
      id
      action
      actor
      headCommit
      note
      at
    }
    gates {
      line
      lines {
        gate
        status
        detail
      }
    }
    sessions {
      id
      conversationId
    }
  }
`;

/**
 * One Change and its diff, read by the checkpoint diff engine (C1).
 *
 * @remarks
 * The diff is asked for **by the Change's own commit pair**, so the pair a hunk is shown from is
 * the pair the server reads: a hunk can never be about commits the client chose. A diff the server
 * could not read (`not_found` while the checkpoint pack is not stored yet) is a failure member
 * the file list renders as "not previewable yet", never as an empty change.
 */
export const TrailDetailChangeDiffFragment = graphql`
  fragment TrailDetailChangeDiff on TrailChange {
    id
    baseCommit
    headCommit
    state
    diff {
      __typename
      ... on ReviewDiff {
        baseCommit
        headCommit
        added
        removed
        # Where the server read the bytes (0248). Both are the server's answer: the screen never
        # chooses a source, it only says which one answered and why the mirror was not used.
        source
        fallback
        mirror {
          side
          commit
          status
          failure
          source
        }
        files {
          path
          change
          added
          removed
          previewable
          hunks {
            baseStart
            headStart
            lines {
              kind
              text
            }
          }
        }
      }
      ... on QueryFailure {
        code
        message
      }
    }
  }
`;

/**
 * Decide a Trail: approve, ask for a revision, or reject (0232).
 *
 * @remarks
 * `headCommit` is the head the screen read, never a fresh one: an approval names the commit the
 * person looked at, and the gate goes back to `fail` the moment a later head exists (C2). The
 * answer carries `nextRunInput`, the open findings as the next Run's input (C4), so a revise is
 * handed over without the screen recomposing it.
 */
export const DecideTrailMutation = graphql`
  mutation TrailDetailDecideMutation($input: DecideTrailInput!) {
    decideTrail(input: $input) {
      __typename
      ... on DecideTrailPayload {
        decision {
          id
          action
          headCommit
        }
        nextRunInput
      }
      ... on MutationFailure {
        code
        message
      }
    }
  }
`;

/**
 * One hunk action: keep, undo, or apply (C1).
 *
 * @remarks
 * One document per action (`keepHunk`, `undoHunk`, `applyHunk`), because a GraphQL document names
 * the field it calls. Every action is a **versioned write**: `expectedVersion` is the file's
 * version the diff was read at, and the server writes only if the file is still there. A
 * `CONFLICT` answer is shown, never retried with a fresh version — that would overwrite a change
 * the person did not see.
 */
export const KeepHunkMutation = graphql`
  mutation TrailDetailKeepHunkMutation($input: ReviewHunkInput!) {
    keepHunk(input: $input) {
      __typename
      ... on ReviewHunkPayload {
        diff {
          baseCommit
          headCommit
        }
      }
      ... on MutationFailure {
        code
        message
      }
    }
  }
`;

/** Undo one hunk: write the base side of it back (C1). */
export const UndoHunkMutation = graphql`
  mutation TrailDetailUndoHunkMutation($input: ReviewHunkInput!) {
    undoHunk(input: $input) {
      __typename
      ... on ReviewHunkPayload {
        diff {
          baseCommit
          headCommit
        }
      }
      ... on MutationFailure {
        code
        message
      }
    }
  }
`;

/** Apply one hunk as the screen resolved it (C1). */
export const ApplyHunkMutation = graphql`
  mutation TrailDetailApplyHunkMutation($input: ReviewHunkInput!) {
    applyHunk(input: $input) {
      __typename
      ... on ReviewHunkPayload {
        diff {
          baseCommit
          headCommit
        }
      }
      ... on MutationFailure {
        code
        message
      }
    }
  }
`;

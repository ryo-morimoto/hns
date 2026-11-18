import { Suspense, type ReactElement } from "react";
import { useLazyLoadQuery } from "react-relay";
import { toGlobalId } from "@hns/core/graphql";
import type { TrailDetailQuery as TrailDetailQueryType } from "../../__generated__/TrailDetailQuery.graphql";
import { Skeleton } from "../../components/Skeleton.tsx";
import { TrailDetailQuery } from "./TrailDetail.ts";
import { TrailDetail } from "./TrailDetail.tsx";

/**
 * A Trail's review face: the read, and the four states it can be in.
 *
 * @param props.trailId - The store's id (the route's segment); the screen turns it into the global
 * id the face takes.
 *
 * @remarks
 * **`not_found` is a state, not an error.** The face answers a missing Trail as a typed failure
 * (0231), so a screen can say "this Trail does not exist" instead of an empty one that looks like
 * loading. The read is the shell's screen read (`useScreenRead`), so a reconnect refreshes it like
 * any other.
 */
export function TrailDetailScreen({ trailId }: { readonly trailId: string }): ReactElement {
  return (
    <Suspense fallback={<TrailDetailFallback />}>
      <TrailDetailRead trailId={trailId} />
    </Suspense>
  );
}

/** The screen's shape while the read is in flight. */
function TrailDetailFallback(): ReactElement {
  return (
    <section className="hns-review" aria-label="読み込み中" aria-busy="true">
      <Skeleton width={220} height={20} />
      <Skeleton width={320} height={12} />
      <Skeleton width={420} height={12} />
    </section>
  );
}

/**
 * Run the one read and hand the Trail record to the face.
 *
 * @remarks
 * The read keeps Relay's default policy (`store-or-network`): a review is opened to look at a
 * Trail and act on it, and the act (a decision or a hunk) is a mutation whose answer invalidates
 * the record, so the next render reads the server. The screen is not in `FRESHNESS` because it
 * has no TTL of its own; when a live frame can carry a Trail's findings or gates, the entry is
 * added there with its reason (D097).
 */
function TrailDetailRead({ trailId }: { readonly trailId: string }): ReactElement {
  const data = useLazyLoadQuery<TrailDetailQueryType>(
    TrailDetailQuery,
    { id: toGlobalId("Trail", trailId) },
    {},
  );
  const answer = data.trail;
  if (answer.__typename !== "TrailPayload") {
    const failure = answer.__typename === "QueryFailure" ? answer : undefined;
    return (
      <section className="hns-review" aria-label="Trail">
        <h1>Trail</h1>
        <p className="hns-review__empty">
          {failure?.code === "NOT_FOUND"
            ? "この Trail はありません。"
            : "Trail を読めません" + (failure === undefined ? "。" : ": " + failure.code)}
        </p>
        {failure === undefined ? null : <p className="hns-review__failure">{failure.message}</p>}
      </section>
    );
  }
  return <TrailDetail trailRef={answer.trail} />;
}

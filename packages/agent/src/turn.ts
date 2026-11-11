import type { Submission } from "@earendil-works/pi-durable";

/** What `Submission.wait()` settles with; Durable's own record, not a copy. */
type Settlement = Awaited<ReturnType<Submission["wait"]>>;

/**
 * One submitted turn, as Durable settled it, plus the text it answered with.
 *
 * @remarks
 * `settlement` is the durable record, so `settlement.status` says whether the model
 * answered. `text` is the newest assistant text and is "" when the turn produced
 * none: read the status to know whether the model answered, not the text.
 */
export interface Turn {
  readonly settlement: Settlement;
  readonly text: string;
}

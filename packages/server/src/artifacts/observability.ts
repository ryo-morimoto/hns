import {
  isoTimestamp,
  type EventLevel,
  type MirrorFailure,
  type MirrorStatus,
  type ObsDetail,
  type ObsLogEntry,
  type ObsMirrorMetrics,
  type ObsMirrorStates,
} from "@hns/core";

/**
 * The Artifacts mirror's observation: one line per decided mirror, and the aggregate a reader
 * asks for.
 *
 * @remarks
 * The mirror is measured from **the outcomes it recorded**, not from the pushes it attempted: the
 * Worker writes one `artifacts.mirror` entry when a push reports (or when a run is settled as
 * `skipped`), and `/api/metrics` reduces those entries into p95, the failure rate, the skip rate,
 * and the number of repositories the window touched. The Workspace object is the writer (it is
 * the only party that knows both the state and the repository), and this module is the one place
 * that shapes the line and the numbers.
 *
 * **No token ever reaches an entry.** The line carries the closed states and failure codes of the
 * checkpoint contract, the repository's name, and the push's duration — nothing a request, a
 * header, or a credential could ride. That is the same rule the machine's redaction follows,
 * expressed as a type: there is no field for a token, so no branch can put one there.
 */

/** What one decided mirror reports. Every field is a closed word, a count, or a duration. */
export interface MirrorObservation {
  /** The repository the workspace mirrors to (`artifactsRepoName`); its name, never its remote. */
  readonly repo: string;
  /** The state the Worker recorded. */
  readonly status: MirrorStatus;
  /** Why a `failed` mirror failed; absent for every other state, as in the contract. */
  readonly failure?: MirrorFailure | undefined;
  /** The push's elapsed milliseconds; absent when nothing was pushed (a `skipped` run). */
  readonly durationMs?: number | undefined;
  /** The correlation id of the request that reported it; null for work no request triggered. */
  readonly requestId: string | null;
  /** Epoch milliseconds. */
  readonly now: number;
}

/**
 * The severity a mirror outcome is written at.
 *
 * @param status - The recorded state.
 * @returns `info` for `mirrored` and `skipped` (both are the mirror working as designed), `warn`
 * for `failed` (an expected failure the operator may want to see), and `info` for `pending`.
 *
 * @remarks
 * A failed mirror is not an `error`: the checkpoint is safe in R2 in every one of them, and
 * `/api/metrics` counts `errors` as `error`-level lines. A broken Artifacts service is visible in
 * the failure rate, not as a server error.
 */
export function mirrorLevelOf(status: MirrorStatus): EventLevel {
  return status === "failed" ? "warn" : "info";
}

/**
 * Build the `artifacts.mirror` entry for one decided mirror.
 *
 * @param observation - The repository, the state, its failure or duration, the request, and the clock.
 * @returns One `ObsLogEntry` on the `do` hop.
 *
 * @remarks
 * The event is the Workspace object's (the `do` hop), because it is the party that decided the
 * state. `status` is not written twice: the event's `detail` carries the mirror's closed state,
 * its closed failure, and the repository. The remote and the token are **not** fields of
 * {@link MirrorObservation} and so cannot be carried here.
 */
export function mirrorObservationEntry(observation: MirrorObservation): ObsLogEntry {
  const base: ObsDetail = { mirror: observation.status, repos: observation.repo };
  const detail: ObsDetail =
    observation.failure === undefined ? base : { ...base, failure: observation.failure };
  const entry: ObsLogEntry = {
    v: 1,
    at: isoTimestamp(new Date(observation.now).toISOString()),
    level: mirrorLevelOf(observation.status),
    event: "artifacts.mirror",
    hop: "do",
    requestId: observation.requestId,
    detail,
  };
  return observation.durationMs === undefined
    ? entry
    : { ...entry, durationMs: observation.durationMs };
}

/** One mirror row as the metrics read it back. */
export interface MirrorRow {
  /** The state the entry records, as its `detail.mirror`. */
  readonly status: MirrorStatus;
  /** The repository the entry names, as its `detail.repos`; a name, or absent. */
  readonly repo: string | undefined;
  /** The push's elapsed milliseconds, when the entry timed one. */
  readonly durationMs: number | undefined;
}

/**
 * Reduce the mirror rows of the window into `/api/metrics`' mirror section.
 *
 * @param rows - The `artifacts.mirror` rows of the window, as {@link mirrorRowsOf} reads them.
 * @param windowMs - The window the rows came from.
 * @returns The counts, the two rates, the p95 of the timed pushes, and how many repositories the
 * window touched.
 *
 * @remarks
 * `total` is every row, so the two rates are shares of **all** mirror outcomes, not of the
 * failures among successes: a workspace whose mirror is mostly skipped shows a high skip rate and a
 * low failure rate. The p95 is **the same expression `/api/metrics` uses for HTTP durations**
 * (`ordered[floor(length * 0.95)]` on the ascending durations, clamped to the last index), so two
 * percentiles in one response are read the same way — it is an index into the sorted sample, not a
 * nearest-rank definition. An untimed push does not enter the percentile.
 */
export function mirrorMetricsOf(rows: readonly MirrorRow[], windowMs: number): ObsMirrorMetrics {
  const count = (status: MirrorStatus): number =>
    rows.filter((row) => row.status === status).length;
  const durations: number[] = [];
  const repos = new Set<string>();
  for (const row of rows) {
    if (row.repo !== undefined) repos.add(row.repo);
    if (row.durationMs !== undefined) durations.push(row.durationMs);
  }
  const total = rows.length;
  const ordered = [...durations].sort((left, right) => left - right);
  const p95Ms =
    ordered.length === 0
      ? 0
      : (ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] ?? 0);
  const failed = count("failed");
  const skipped = count("skipped");
  const states: ObsMirrorStates = {
    mirrored: count("mirrored"),
    skipped,
    failed,
    pending: count("pending"),
  };
  return {
    windowMs,
    total,
    states,
    failureRate: total === 0 ? 0 : failed / total,
    skipRate: total === 0 ? 0 : skipped / total,
    p95Ms,
    repos: repos.size,
  };
}

/**
 * Turn a mirror entry back into the row the metrics reduce.
 *
 * @param entry - A stored entry of any event.
 * @returns The row for an `artifacts.mirror` entry, or undefined for any other event.
 *
 * @remarks
 * An entry whose `detail.mirror` is not one of the contract's states is skipped rather than
 * defaulted: a row the vocabulary does not name is corruption, and it must not be counted as
 * one of the four. The same rule the stored log applies to a corrupt line.
 */
export function mirrorRowOf(entry: ObsLogEntry): MirrorRow | undefined {
  if (entry.event !== "artifacts.mirror") return undefined;
  const mirror = entry.detail?.mirror;
  const status = mirrorStatusOf(mirror);
  if (status === undefined) return undefined;
  // The detail is the allowlist's, so `repos` is a string or absent; the entry's schema decided
  // that when it was read, so the row keeps it as the entry has it. A detail value that is not a
  // name (a number or a flag a future key put there) is not a repository and names none.
  const repos = entry.detail?.repos === undefined ? undefined : String(entry.detail.repos);
  return {
    status,
    repo: repos,
    durationMs: entry.durationMs,
  };
}

/** The closed status one `detail.mirror` value stands for, or undefined. */
function mirrorStatusOf(
  value: string | number | boolean | null | undefined,
): MirrorStatus | undefined {
  switch (value) {
    case "pending":
    case "mirrored":
    case "skipped":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

/**
 * The mirror rows of a stored log page.
 *
 * @param entries - Entries as `ObsStore.list` answers them (newest first, bounded by the query).
 * @returns Only the `artifacts.mirror` rows, in the order they arrived.
 *
 * @remarks
 * The metrics read the mirror from the same log every other number comes from, so there is no
 * second store to keep consistent. The page is bounded by the log's own cap
 * (`OBS_MAX_EVENTS`), which is the window's ceiling: a busy workspace's mirror numbers are
 * **at least** what the page shows, exactly as the HTTP counts are.
 */
export function mirrorRowsOf(entries: readonly ObsLogEntry[]): MirrorRow[] {
  const rows: MirrorRow[] = [];
  for (const entry of entries) {
    const row = mirrorRowOf(entry);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

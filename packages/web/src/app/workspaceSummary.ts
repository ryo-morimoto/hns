import type { ProjectId } from "@hns/core";

/** The sidebar's cross-workspace summary. Fixture-only until the overview API exists. */
export interface WorkspaceSummary {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly needsYou: number;
  readonly running: number;
  readonly failed: number;
  readonly doneToday: number;
  readonly lastActivityAt: string | null;
}

export interface WorkspaceTotals {
  readonly needsYou: number;
  readonly running: number;
  readonly failed: number;
  readonly doneToday: number;
}

export function totalsOf(summaries: readonly WorkspaceSummary[]): WorkspaceTotals {
  return summaries.reduce<WorkspaceTotals>(
    (totals, summary) => ({
      needsYou: totals.needsYou + summary.needsYou,
      running: totals.running + summary.running,
      failed: totals.failed + summary.failed,
      doneToday: totals.doneToday + summary.doneToday,
    }),
    { needsYou: 0, running: 0, failed: 0, doneToday: 0 },
  );
}

export function breakdownOf(
  summaries: readonly WorkspaceSummary[],
  key: keyof WorkspaceTotals,
): string {
  const parts: string[] = [];
  for (const summary of summaries) {
    const count = summary[key];
    if (count > 0) parts.push(summary.name + " " + String(count));
  }
  return parts.join(" · ");
}

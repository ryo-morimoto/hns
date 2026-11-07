import { ProjectIdSchema, type ProjectId } from "@hns/core";
import * as v from "valibot";
import type { WorkspaceSummary } from "./workspaceSummary.ts";

const projectId = (value: string): ProjectId => v.parse(ProjectIdSchema, value);
const now = Date.now();

function ago(minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

/** Fixture-only until 0115 returns these counts. The second workspace has no needs/running. */
const FIXTURE_WORKSPACE_SUMMARIES: readonly WorkspaceSummary[] = [
  {
    projectId: projectId("project-hns"),
    name: "hns",
    needsYou: 1,
    running: 2,
    failed: 0,
    doneToday: 3,
    lastActivityAt: ago(12),
  },
  {
    projectId: projectId("project-docs"),
    name: "docs",
    needsYou: 0,
    running: 1,
    failed: 0,
    doneToday: 0,
    lastActivityAt: ago(5),
  },
  {
    projectId: projectId("project-scratch"),
    name: "scratch",
    needsYou: 0,
    running: 0,
    failed: 0,
    doneToday: 0,
    lastActivityAt: ago(120),
  },
];

export function fixtureSummarySource(): Promise<readonly WorkspaceSummary[]> {
  return Promise.resolve(FIXTURE_WORKSPACE_SUMMARIES);
}

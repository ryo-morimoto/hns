import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { Workspace } from "../src/index.ts";
import type { WorkspaceOptions } from "../src/index.ts";

export const KINDS = ["node", "local"] as const;
type Kind = (typeof KINDS)[number];

/**
 * How one tier runs a scenario. "checks" stays in this process; the others
 * spawn the rooted helper or the pi-env daemon for every operation.
 */
export interface TestTarget {
  readonly kind: Kind;
  readonly rooted: boolean;
  readonly label: string;
}

export type Tier = "unit" | "integration";

declare module "vitest" {
  export interface ProvidedContext {
    tier: Tier;
  }
}

const UNIT_TARGETS: readonly TestTarget[] = [{ kind: "node", rooted: false, label: "node/checks" }];
const INTEGRATION_TARGETS: readonly TestTarget[] = [
  { kind: "node", rooted: true, label: "node/dirfd" },
  { kind: "local", rooted: true, label: "local/dirfd" },
];

/** The vitest project decides the tier; the same scenario file runs in both. */
export const targetsForTier = (tier: Tier): readonly TestTarget[] =>
  tier === "integration" ? INTEGRATION_TARGETS : UNIT_TARGETS;

export interface Target {
  readonly base: string;
  readonly env: ExecutionEnv;
  readonly rooted: boolean;
}

/** Run against one target: in-process, the rooted helper, or the pi-env daemon. */
export async function withTarget(
  testTarget: TestTarget,
  run: (target: Target) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-workspace-"));
  let close = async (): Promise<void> => {};
  let env: ExecutionEnv;
  if (testTarget.kind === "node") {
    env = new NodeExecutionEnv({ cwd: base });
  } else {
    const connection = new Connection({ command: [localDaemon()] });
    env = new LocalExecutionEnv({ cwd: base, connection });
    close = async () => {
      await connection.close();
    };
  }
  try {
    await run({ base, env, rooted: testTarget.rooted });
  } finally {
    await close();
    await rm(base, { recursive: true, force: true });
  }
}

/** The root a named workspace uses; created on the way. */
export function rootOf(target: Target, name: string): string {
  return join(target.base, "root-" + name);
}

export async function openWorkspace(
  target: Target,
  name: string,
  options: Partial<WorkspaceOptions> = {},
): Promise<Workspace> {
  const root = rootOf(target, name);
  await target.env.createDir(root, { recursive: true }, ctx);
  return Workspace.open({
    env: target.env,
    root,
    journalPath: join(target.base, "journal-" + name + ".json"),
    context: ctx,
    rooted: target.rooted,
    ...options,
  });
}

/** Move a directory aside and put a link to `outside` in its place. */
export async function swapParent(root: string, name: string, outside: string): Promise<void> {
  await rename(join(root, name), join(root, name + "-old"));
  await symlink(outside, join(root, name));
}

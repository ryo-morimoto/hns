import { mkdtemp, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { Workspace } from "../src/index.ts";
import type { WorkspaceOptions } from "../src/index.ts";

export const KINDS = ["node", "local"] as const;
export type Kind = (typeof KINDS)[number];

export interface Target {
  readonly base: string;
  readonly env: ExecutionEnv;
}

/** Run against both environments: the in-process one and the pi-env daemon. */
export async function withTarget(
  kind: Kind,
  run: (target: Target) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-workspace-"));
  let close = async (): Promise<void> => {};
  let env: ExecutionEnv;
  if (kind === "node") {
    env = new NodeExecutionEnv({ cwd: base });
  } else {
    const connection = new Connection({ command: [localDaemon()] });
    env = new LocalExecutionEnv({ cwd: base, connection });
    close = async () => {
      await connection.close();
    };
  }
  try {
    await run({ base, env });
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
    ...options,
  });
}

/** Move a directory aside and put a link to \`outside\` in its place. */
export async function swapParent(root: string, name: string, outside: string): Promise<void> {
  await rename(join(root, name), join(root, name + "-old"));
  await symlink(outside, join(root, name));
}

/** Undo a swap. */
export async function restoreParent(root: string, name: string): Promise<void> {
  await unlink(join(root, name));
  await rename(join(root, name + "-old"), join(root, name));
}

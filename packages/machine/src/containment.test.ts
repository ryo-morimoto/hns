import { expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Denied } from "@hns/workspace";
import { containInRoot, normalizeRelative } from "./containment.ts";
import { MachineRefusal } from "./refusal.ts";

test("normalization names stay inside the root", () => {
  expect(normalizeRelative("a/b.txt")).toBe("a/b.txt");
  expect(normalizeRelative("/a//b/./c")).toBe("a/b/c");
  expect(normalizeRelative("a\\b")).toBe("a/b");
  expect(normalizeRelative("")).toBe("");
  expect(normalizeRelative("/")).toBe("");
  expect(normalizeRelative(".")).toBe("");
  expect(() => normalizeRelative("../a")).toThrow(Denied);
  expect(() => normalizeRelative("a/../../b")).toThrow(Denied);
  expect(() => normalizeRelative("C:\\windows")).toThrow(Denied);
  expect(() => normalizeRelative("a\0b")).toThrow(Denied);
});

interface TempPaths {
  /** The canonical root the agent would pin. */
  readonly root: string;
  /** A directory beside the root, standing in for the rest of the machine. */
  readonly base: string;
}

async function withRoot(run: (paths: TempPaths) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-machine-root-"));
  const root = join(base, "root");
  await mkdir(root);
  try {
    await run({ root: await realpath(root), base });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("a path inside the root resolves through its canonical parent", async () => {
  await withRoot(async ({ root }) => {
    await writeFile(join(root, "a.txt"), "hello");
    const file = await containInRoot(root, "a.txt");
    expect(file).toStrictEqual({ relative: "a.txt", absolute: join(root, "a.txt") });
    const itself = await containInRoot(root, "/");
    expect(itself).toStrictEqual({ relative: "", absolute: root });
  });
});

test("a missing parent is absent, not a containment violation", async () => {
  await withRoot(async ({ root }) => {
    const error = await containInRoot(root, "missing/a.txt").then(
      () => undefined,
      (reason: Error) => reason,
    );
    expect(error).toBeInstanceOf(MachineRefusal);
    if (!(error instanceof MachineRefusal)) throw new Error("expected a refusal");
    expect(error.code).toBe("not_found");
  });
});

test("a symbolic link as a parent does not escape the root", async () => {
  await withRoot(async ({ root, base }) => {
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "secret.txt"), "secret");
    await symlink(join(base, "outside"), join(root, "link"));
    await expect(containInRoot(root, "link/secret.txt")).rejects.toBeInstanceOf(Denied);
  });
});

test("a symbolic link inside the root resolves to its target inside the root", async () => {
  await withRoot(async ({ root }) => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    const resolved = await containInRoot(root, "alias/a.txt");
    expect(resolved.absolute).toBe(join(root, "real", "a.txt"));
  });
});

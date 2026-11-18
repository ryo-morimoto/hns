import { expect, test } from "vitest";
import { officeParamsHash, officePathHash } from "@hns/core/office";
import { createOfficeRows } from "./office-rows.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
/** A version for one row: a content hash in the contract's one spelling. */
const VERSION_A = "sha256:" + "a".repeat(64);
const VERSION_B = "sha256:" + "b".repeat(64);

/** One row's identity for `docs/office.md` \`preview\` of one path. */
async function keyOf(version: string, path = "提案書.docx") {
  return {
    workspaceId: "project-1",
    path,
    version,
    format: "docx" as const,
    operation: "preview" as const,
    pathHash: await officePathHash(path),
    paramsHash: await officeParamsHash("preview", {}),
  };
}

/** A row's state as a request writes it. */
const queued = (now: number) => ({
  status: "queued" as const,
  code: null,
  message: null,
  pages: null,
  bytes: null,
  engine: null,
  attempts: 0,
  jobId: null,
  now,
});

// Catches: two requests for one (workspace, path, version) leaving two rows, so a second request
// queues a second job (C2).
test("two writes for one key leave one row", async () => {
  const opened = openSqliteState();
  try {
    const rows = createOfficeRows(opened.state.storage);
    const key = await keyOf(VERSION_A);
    await rows.write(key, queued(1));
    await rows.write(key, queued(2));
    const all = await rows.rowsFor("project-1", key.path);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("queued");
    expect(all[0]?.paramsHash).toBe(key.paramsHash);
  } finally {
    opened.close();
  }
});

// Catches: a new version's request leaving the old version's row behind, so a route could serve
// a preview of bytes the file no longer has (C4).
test("a request for a new version deletes the old version of the path", async () => {
  const opened = openSqliteState();
  try {
    const rows = createOfficeRows(opened.state.storage);
    const key = await keyOf(VERSION_A);
    await rows.write(key, queued(1));
    await rows.update("project-1", key.path, VERSION_A, {
      status: "ready",
      pages: 3,
      bytes: 10,
      engine: "0.8.7",
      now: 2,
    });
    await rows.write(await keyOf(VERSION_B), queued(3));
    const all = await rows.rowsFor("project-1", key.path);
    expect(all.map((row) => row.version)).toStrictEqual([VERSION_B]);
    expect(await rows.get("project-1", key.path, VERSION_A)).toBeUndefined();
  } finally {
    opened.close();
  }
});

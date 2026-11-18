import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { officeAuditDetail } from "@hns/core/office";
import { OFFICE_JOB_DETAIL_KEYS, createObsStore, officeDetailAllowed } from "./store.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
/** The detail one office attempt writes (docs/office.md §7). */
const DETAIL = officeAuditDetail({
  jobId: "office-0001",
  operation: "preview",
  path: "提案書.docx",
  version: "sha256:" + "a".repeat(64),
  inputHash: "b".repeat(64),
  engineVersion: "0.8.7",
  ms: 1200,
  outcome: "ready",
});

// Catches: an office.job line carrying a cell value, a paragraph, or any key the contract does
// not name — the row is the closest an audit gets to a person's document (C7).
test("an office.job line carries only its own keys, and nothing of the document", () => {
  // `path` is the line's own column, so it is the one key the detail does not carry.
  const detailKeys = Object.keys(DETAIL).filter((key) => key !== "path");
  for (const key of detailKeys) expect(officeDetailAllowed("office.job", key)).toBe(true);
  expect(officeDetailAllowed("office.job", "path")).toBe(false);
  for (const key of ["text", "cells", "content", "bytes", "paragraph", "message"]) {
    expect(officeDetailAllowed("office.job", key)).toBe(false);
  }
  // The other events keep the log-wide allowlist; this rule is the office row's alone.
  expect(officeDetailAllowed("http", "bytes")).toBe(true);
});

test("the log refuses an office.job detail key it does not name", () => {
  const opened = openSqliteState();
  try {
    const store = createObsStore(opened.state.storage);
    // SAFETY: the value is what a caller might write by mistake; the store is what refuses it.
    // The log's own allowlist drops `text` before the office rule sees it; the office rule is
    // what a key outside *its* list hits, and `parseObsLog` keeps `bytes` (a log-wide key).
    expect(() =>
      store.append({
        v: 1,
        at: isoTimestamp("2026-11-19T00:00:00.000Z"),
        level: "info",
        event: "office.job",
        hop: "do",
        requestId: null,
        detail: { ...DETAIL, bytes: 10 } as never,
      }),
    ).toThrow("no detail key bytes");
  } finally {
    opened.close();
  }
});

test("an office.job line round-trips with its keys", () => {
  const opened = openSqliteState();
  try {
    const store = createObsStore(opened.state.storage);
    store.append({
      v: 1,
      at: isoTimestamp("2026-11-19T00:00:00.000Z"),
      level: "info",
      event: "office.job",
      hop: "do",
      requestId: null,
      detail: DETAIL,
    });
    const [line] = store.list();
    expect(line?.event).toBe("office.job");
    expect(Object.keys(line?.detail ?? {}).sort()).toStrictEqual(
      [...OFFICE_JOB_DETAIL_KEYS].sort(),
    );
  } finally {
    opened.close();
  }
});

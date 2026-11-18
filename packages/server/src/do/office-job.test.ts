import { expect, test } from "vitest";
import * as v from "valibot";
import { OfficeJobSchema, officeParamsHash, officePathHash } from "@hns/core/office";
import type { OfficeEngineReport, OfficeJob, OfficeResult } from "@hns/core/office";
import {
  OFFICE_PROBE_TIMEOUT_MS,
  createOfficePreview,
  nextOfficeAlarm,
  officeAlarmFor,
  previewUrl,
} from "./office-job.ts";
import { OFFICE_MAX_ATTEMPTS, OFFICE_ROW_TTL_MS, createOfficeRows } from "./office-rows.ts";
import type { OfficePreviewRow } from "./office-rows.ts";
import type { OfficeEngineProbeAnswer, OfficeJobAnswer } from "./office-job.ts";
import { officeRowDecision } from "./office-row-decision.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
/** The version of the file a test previews. */
const VERSION = "sha256:" + "c".repeat(64);
const WORKSPACE = "project-1";
const PATH = "提案書.docx";

/** An engine report for the pack the contract ships (docs/office.md §11). */
const AVAILABLE: OfficeEngineReport = {
  available: true,
  id: "ibisoffice",
  version: "0.8.7",
  formats: ["docx", "xlsx", "pptx"],
  operations: ["preview", "render", "convert"],
};

/** The artifact one successful preview answers with. */
async function artifact(): Promise<OfficeResult> {
  return {
    ok: true,
    artifact: {
      key: {
        workspaceId: WORKSPACE,
        pathHash: await officePathHash(PATH),
        version: VERSION,
        operation: "preview",
        paramsHash: await officeParamsHash("preview", {}),
      },
      workspaceId: WORKSPACE,
      pathHash: await officePathHash(PATH),
      version: VERSION,
      file: "pdf",
      sha256: "sha256:" + "d".repeat(64),
      bytes: 31 * 1024 * 1024,
      pages: 12,
      missingFonts: [],
      engine: { id: "ibisoffice", version: "0.8.7" },
    },
    stats: { ms: 1200, peakRssMb: 300, cached: false },
  };
}

/** A probe that answers one report. */
const probeOf = (report: OfficeEngineReport) => async (): Promise<OfficeEngineProbeAnswer> => ({
  kind: "report",
  report,
});

/** A clock a test moves by hand. */
function clockAt(start: number) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** What a test may replace about the face's machine. */
interface FaceOptions {
  readonly clock?: ReturnType<typeof clockAt>;
  readonly job?: (job: OfficeJob) => Promise<OfficeJobAnswer>;
  readonly probe?: () => Promise<OfficeEngineProbeAnswer>;
  /** True for a Session with no machine at all: no probe and no job. */
  readonly noMachine?: boolean;
}

/** One face over a fresh SQLite, with the machine and the clock a test supplies. */
function face(overrides: FaceOptions = {}) {
  const opened = openSqliteState();
  const clock = overrides.clock ?? clockAt(1_000);
  const jobs: OfficeJob[] = [];
  const records: string[] = [];
  const job =
    overrides.job ??
    (async (): Promise<OfficeJobAnswer> => ({ kind: "result", result: await artifact() }));
  const preview = createOfficePreview({
    rows: createOfficeRows(opened.state.storage),
    now: clock.now,
    machine:
      overrides.noMachine === true
        ? undefined
        : {
            probe: overrides.probe ?? probeOf(AVAILABLE),
            job: async (input) => {
              jobs.push(input);
              return await job(input);
            },
          },
    record: async (record) => {
      records.push(record.outcome);
    },
  });
  return { preview, clock, jobs, records, opened };
}

/** One request for the test file's path. */
const request = { workspaceId: WORKSPACE, path: PATH, version: VERSION };

// Catches: a request that runs the job inline (the edge answers in ten seconds; a conversion
// takes a minute) or that writes no alarm, so a queued row would never run (C3).
test("a request writes a queued row and arms the alarm without running the job", async () => {
  const { preview, jobs, opened } = face();
  try {
    const answer = await preview.request(request);
    expect(answer.row.status).toBe("queued");
    expect(answer.nextAlarmAt).toBe(1_000);
    expect(jobs).toHaveLength(0);
  } finally {
    opened.close();
  }
});

// Catches: asking twice for the same version queueing two jobs — the row that is still queued is
// reused, and the alarm is armed for it once more (C2).
test("a second request for the same version reuses the row and queues nothing", async () => {
  const { preview, clock, jobs, opened } = face();
  try {
    await preview.request(request);
    clock.advance(10);
    const again = await preview.request(request);
    expect(again.row.status).toBe("queued");
    expect((await preview.rowOf(WORKSPACE, PATH, VERSION))?.status).toBe("queued");
    expect(jobs).toHaveLength(0);
  } finally {
    opened.close();
  }
});

// Catches: a request after a terminal row reusing it, so a person who installed a pack could never
// ask again (0237 acceptance 4).
test("a request after a terminal row replaces it", async () => {
  const { preview, jobs, opened } = face({
    probe: probeOf({ available: false, reason: "no pack" }),
  });
  try {
    const disabled = await preview.request(request);
    expect(disabled.row.status).toBe("disabled");
    const replaced = await preview.request(request);
    expect(replaced.row.status).toBe("disabled");
    expect(jobs).toHaveLength(0);
  } finally {
    opened.close();
  }
});

// Catches: a machine with no pack being recorded as an error of the file, or an alarm armed for a
// job that cannot run (C5).
test("no pack on the machine writes a disabled row and arms nothing", async () => {
  const { preview, jobs, opened } = face({
    probe: probeOf({ available: false, reason: "no office pack is installed on this machine" }),
  });
  try {
    const answer = await preview.request(request);
    expect(answer.row.status).toBe("disabled");
    expect(answer.nextAlarmAt).toBeUndefined();
    expect(jobs).toHaveLength(0);
  } finally {
    opened.close();
  }
});

// Catches: a format the pack does not handle queuing a job that would fail, and a format this
// build never previews asking the machine at all.
test("an unsupported format is unsupported without asking the machine", async () => {
  const asked: string[] = [];
  const { preview, opened } = face({
    probe: async () => {
      asked.push("probe");
      // A pack that has preview but not docx: the second request is a format it cannot read.
      // The first probe declares docx (the `notes.odt` request never probes at all); this one is
      // a pack that previews but does not read docx.
      return { kind: "report", report: { ...AVAILABLE, formats: ["xlsx"] } };
    },
  });
  try {
    const odt = await preview.request({
      workspaceId: WORKSPACE,
      path: "notes.odt",
      version: VERSION,
    });
    expect(odt.row.status).toBe("unsupported");
    expect(odt.nextAlarmAt).toBeUndefined();
    expect(asked).toHaveLength(0);
    // A format the pack does declare asks the machine first, so a pack without it is found before
    // a job is queued.
    const missing = await preview.request({
      workspaceId: WORKSPACE,
      path: "deck.docx",
      version: VERSION,
    });
    expect(asked).toHaveLength(1);
    expect(missing.row.status).toBe("unsupported");
  } finally {
    opened.close();
  }
});

// Catches: a machine that cannot be reached being recorded as `disabled` (C10: only a report that
// says there is no pack is disabled), or a request waiting on it instead of writing `queued`.
test("an unreachable machine leaves the request queued, never disabled", async () => {
  const { preview, opened } = face({
    probe: async () => ({ kind: "unavailable" }),
  });
  try {
    const answer = await preview.request(request);
    expect(answer.row.status).toBe("queued");
    expect(answer.nextAlarmAt).toBe(1_000);
  } finally {
    opened.close();
  }
});

// Catches: a machine that stays down settling the row as `failed` at once (the contract keeps it
// `stale` until the attempts run out), or the attempts never ending (C6 / C10).
test("an unreachable machine goes stale, retries, and finally fails with engine_unavailable", async () => {
  const clock = clockAt(1_000);
  const { preview, jobs, records, opened } = face({
    clock,
    job: async () => ({ kind: "unavailable", detail: "transport" }),
  });
  try {
    await preview.request(request);
    for (let attempt = 1; attempt < OFFICE_MAX_ATTEMPTS; attempt += 1) {
      const pass = await preview.run(WORKSPACE);
      const row = await preview.rowOf(WORKSPACE, PATH, VERSION);
      expect(row?.status).toBe("stale");
      // The next attempt is due after the retry pause, and the alarm is armed for it.
      expect(pass.nextAlarmAt).toBe(clock.now() + 30_000);
      clock.advance(30_000);
    }
    const last = await preview.run(WORKSPACE);
    const row = await preview.rowOf(WORKSPACE, PATH, VERSION);
    expect(row?.status).toBe("failed");
    expect(row?.code).toBe("engine_unavailable");
    expect(last.nextAlarmAt).toBeUndefined();
    expect(jobs).toHaveLength(OFFICE_MAX_ATTEMPTS);
    expect(records.at(-1)).toBe("failed");
  } finally {
    opened.close();
  }
});

// Catches: the alarm finishing without writing the row (a poll would never see `ready`), or the
// job being answered with a row whose facts did not come from the artifact (C3).
test("the alarm runs the queued row and writes ready", async () => {
  const clock = clockAt(1_000);
  const { preview, jobs, records, opened } = face({ clock });
  try {
    await preview.request(request);
    clock.advance(5);
    const pass = await preview.run(WORKSPACE);
    const row = await preview.rowOf(WORKSPACE, PATH, VERSION);
    expect(row?.status).toBe("ready");
    expect(row?.pages).toBe(12);
    expect(row?.engine).toBe("0.8.7");
    expect(row?.bytes).toBe(31 * 1024 * 1024);
    expect(pass.nextAlarmAt).toBeUndefined();
    expect(jobs).toHaveLength(1);
    // The job the alarm sent is a contract job: it parses, and it names the row it previews.
    const job = jobs[0];
    if (job === undefined) throw new Error("no job");
    expect(v.safeParse(OfficeJobSchema, job).success).toBe(true);
    expect(job.input).toStrictEqual({
      workspaceId: WORKSPACE,
      path: PATH,
      version: VERSION,
      format: "docx",
    });
    expect(records).toStrictEqual(["ready"]);
  } finally {
    opened.close();
  }
});

// Catches: a job that ran and refused being written without its code, or a format refusal being
// written as `failed` (docs/office.md §9 keeps `unsupported` and a failure apart).
test("a job's expected failure is written with its code on the failed row", async () => {
  const { preview, opened } = face({
    job: async () => ({
      kind: "result",
      result: { ok: false, error: "engine_timeout", message: "the engine ran out of time" },
    }),
  });
  try {
    await preview.request(request);
    await preview.run(WORKSPACE);
    const row = await preview.rowOf(WORKSPACE, PATH, VERSION);
    expect(row?.status).toBe("failed");
    expect(row?.code).toBe("engine_timeout");
    expect(row?.message).toBe("the engine ran out of time");
  } finally {
    opened.close();
  }
});

// Catches: a ready row served from a URL with no workspace, path, or version, which the route
// could not authorise or resolve (0237 §6).
test("a ready row names the session route its bytes are read at", async () => {
  const { preview, opened } = face();
  try {
    await preview.request(request);
    await preview.run(WORKSPACE);
    const row = await preview.rowOf(WORKSPACE, PATH, VERSION);
    if (row === undefined) throw new Error("no row");
    const url = new URL(previewUrl(row), "https://hns.test");
    expect(url.pathname).toBe("/api/office/preview");
    expect(url.searchParams.get("workspaceId")).toBe(WORKSPACE);
    expect(url.searchParams.get("path")).toBe(PATH);
    expect(url.searchParams.get("v")).toBe(VERSION);
  } finally {
    opened.close();
  }
});

// Catches: a request waiting on a silent machine for the whole edge budget: the probe answers
// `unavailable` after its own short deadline, and the request still writes `queued` (C10).
test("a probe that never answers is no answer, and the request still queues", async () => {
  const opened = openSqliteState();
  try {
    const preview = createOfficePreview({
      rows: createOfficeRows(opened.state.storage),
      now: () => 1_000,
      machine: {
        probe: () => new Promise<OfficeEngineProbeAnswer>(() => undefined),
        job: async () => ({ kind: "unavailable", detail: "unused" }),
      },
      probeTimeoutMs: 5,
    });
    const started = Date.now();
    const answer = await preview.request(request);
    // The probe's own deadline answered: the request did not wait for the machine.
    expect(Date.now() - started).toBeLessThan(OFFICE_PROBE_TIMEOUT_MS);
    expect(answer.row.status).toBe("queued");
  } finally {
    opened.close();
  }
});

// Catches: a row decision that reuses a terminal row (a person could never ask again) or writes
// over an unfinished one (two requests, two jobs).
test("the row decision reuses only an unfinished row of the same key", async () => {
  const { preview, opened } = face();
  try {
    await preview.request(request);
    const queuedRow = await preview.rowOf(WORKSPACE, PATH, VERSION);
    if (queuedRow === undefined) throw new Error("no row");
    expect(officeRowDecision(queuedRow, WORKSPACE, PATH, VERSION).kind).toBe("reuse");
    expect(officeRowDecision(queuedRow, WORKSPACE, PATH, "sha256:" + "e".repeat(64)).kind).toBe(
      "write",
    );
    expect(officeRowDecision(undefined, WORKSPACE, PATH, VERSION).kind).toBe("write");
    expect(
      officeRowDecision({ ...queuedRow, status: "failed" }, WORKSPACE, PATH, VERSION).kind,
    ).toBe("write");
  } finally {
    opened.close();
  }
});
// Catches: the alarm running the job without first writing `generating`, so a poll during a
// sixty-second conversion reads a stale `queued` and a client cannot tell work is under way (C3).
test("an alarm attempt writes generating before it asks the machine", async () => {
  const opened = openSqliteState();
  let rowDuringJob: string | undefined;
  const rows = createOfficeRows(opened.state.storage);
  const face = createOfficePreview({
    rows,
    now: () => 1_000,
    machine: {
      probe: async () => ({ kind: "report", report: AVAILABLE }),
      // The row as the machine call finds it: the attempt must already have written generating.
      job: async () => {
        rowDuringJob = (await rows.get(WORKSPACE, "提案書.docx", VERSION))?.status;
        return { kind: "unavailable", detail: "transport" };
      },
    },
  });
  try {
    await face.request({ workspaceId: WORKSPACE, path: "提案書.docx", version: VERSION });
    await face.run(WORKSPACE);
    expect(rowDuringJob).toBe("generating");
    // The attempt then settles the row: no answer is stale, not ready.
    expect((await rows.get(WORKSPACE, "提案書.docx", VERSION))?.status).toBe("stale");
  } finally {
    opened.close();
  }
});

// Catches: a request reusing a queued row after the engine went away, leaving a job that can
// never run (C5 / NB1). The probe decides the row, not the row that happened to be there.
test("a request whose probe now says there is no engine replaces its queued row", async () => {
  const opened = openSqliteState();
  const rows = createOfficeRows(opened.state.storage);
  let available = true;
  const face = createOfficePreview({
    rows,
    now: () => 1_000,
    machine: {
      probe: async () =>
        available
          ? { kind: "report", report: AVAILABLE }
          : { kind: "report", report: { available: false, reason: "no pack" } },
      job: async () => ({ kind: "unavailable", detail: "unused" }),
    },
  });
  try {
    const first = await face.request({
      workspaceId: WORKSPACE,
      path: "提案書.docx",
      version: VERSION,
    });
    expect(first.row.status).toBe("queued");
    available = false;
    const second = await face.request({
      workspaceId: WORKSPACE,
      path: "提案書.docx",
      version: VERSION,
    });
    expect(second.row.status).toBe("disabled");
    expect(second.nextAlarmAt).toBeUndefined();
  } finally {
    opened.close();
  }
});

// Catches: the alarm arming in the past for a row whose retry already fell due (an alarm that
// fires at once, a spin), or arming past the row deadline because a retry moved it (C9, as the
// reviewer fixed it: the TTL is a deadline from the row creation, not a pause between attempts).
test("the next alarm is the due moment, and the row deadline bounds it", () => {
  const row = (
    status: "queued" | "generating" | "stale",
    updatedAt: number,
    createdAt = 0,
  ): OfficePreviewRow => ({
    workspaceId: WORKSPACE,
    path: PATH,
    version: VERSION,
    format: "docx",
    operation: "preview",
    status,
    code: null,
    message: null,
    pages: null,
    bytes: null,
    engine: null,
    updatedAt,
    createdAt,
    paramsHash: "",
    pathHash: "",
    attempts: 0,
    jobId: null,
  });
  const now = 1_000_000;
  // A stale row is due after its retry pause; a queued or generating one is due now.
  expect(nextOfficeAlarm([row("stale", now, now)], now)).toBe(now + 30_000);
  expect(nextOfficeAlarm([row("queued", now, now)], now)).toBe(now);
  expect(nextOfficeAlarm([row("generating", now, now)], now)).toBe(now);
  // A due moment already passed is clamped to now (never an alarm in the past).
  expect(nextOfficeAlarm([row("stale", 0, now)], now)).toBe(now);
  // The deadline is created_at + TTL and a **retry does not move it**: a stale row whose retry
  // falls after the deadline is armed at the deadline, not after it.
  expect(officeAlarmFor(row("stale", now, now - OFFICE_ROW_TTL_MS + 1_000), now)).toBe(now + 1_000);
  // A row already past its deadline is due now, where the pass settles it as failed.
  expect(officeAlarmFor(row("stale", now, now - OFFICE_ROW_TTL_MS - 50_000), now)).toBe(now);
  // The earliest of several rows wins, and no unfinished row leaves nothing to arm.
  expect(nextOfficeAlarm([row("stale", now, now), row("queued", now, now)], now)).toBe(now);
  expect(nextOfficeAlarm([], now)).toBeUndefined();
});

// Catches: a Session with no machine at all (no office bindings) answering `queued` for a job
// that can never run: the deployment has no engine, so the row says `disabled` (C5).
test("a session with no machine writes a disabled row and arms nothing", async () => {
  const opened = openSqliteState();
  try {
    const rows = createOfficeRows(opened.state.storage);
    const face = createOfficePreview({ rows, now: () => 1_000 });
    const answer = await face.request({
      workspaceId: WORKSPACE,
      path: PATH,
      version: VERSION,
    });
    expect(answer.row.status).toBe("disabled");
    expect(answer.nextAlarmAt).toBeUndefined();
  } finally {
    opened.close();
  }
});

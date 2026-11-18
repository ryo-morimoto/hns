import { expect, test } from "vitest";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICE_CACHE_UNAVAILABLE_REASON } from "@hns/core";
import type { MachineWriteRequest } from "@hns/core";
import { DEFAULT_LIMITS } from "./limits.ts";
import { runOperation } from "./operations.ts";
import { MachineRefusal } from "./refusal.ts";
import { parseOperation } from "./wire.ts";

/**
 * A write whose bytes come from the office cache (0241; D103 §5).
 *
 * @remarks
 * The body carries no bytes: it names the 5-tuple the `office` op answered with. Until 0241 reads
 * the cache and copies the file, the machine must refuse this route rather than write something
 * else — and it must refuse it **after the parse**, as `invalid_request`, having written nothing.
 * A test that only exercised the schema would pass with the refusal deleted; this one goes through
 * `parseOperation` and `runOperation`, the same two calls a signed request makes.
 */
const sourceWrite = {
  op: "write",
  projectRoot: "projects/one",
  path: "提案書.pdf",
  expectedVersion: "absent",
  operationId: "op-1753",
  contentHash: "sha256:2b3f9c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
  source: {
    kind: "office-cache",
    workspaceId: "ws-1",
    pathHash: "3f1a2b3c4d5e6f70",
    version: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    operation: "preview",
    paramsHash: "a1b2c3d4e5f60718",
  },
} as const satisfies MachineWriteRequest;

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-machine-office-"));
  const root = join(base, "root");
  await mkdir(join(root, "projects", "one"), { recursive: true });
  try {
    await run(await realpath(root));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// Catches: a `source` write that the machine treats like a `content` write, so the office cache
// route would write nothing (or the wrong bytes) instead of saying "not yet". It also pins that
// the refusal is `invalid_request` and not one of the file failures: a row that reads
// `unsupported_command` would tell a person the engine cannot convert, which is false.
test("a source write is refused invalid_request and writes nothing", async () => {
  await withRoot(async (root) => {
    const body = new TextEncoder().encode(JSON.stringify(sourceWrite));
    const parsed = parseOperation(body);
    // `tool` is the one granted-call envelope; these bodies are operations.
    expect(parsed.op).toBe("write");
    if (parsed.op === "tool" || parsed.op !== "write" || !("source" in parsed)) {
      throw new Error("expected a source write");
    }
    const operation = parsed;

    const controller = new AbortController();
    const error = await runOperation(operation, root, DEFAULT_LIMITS, controller.signal).then(
      () => undefined,
      (reason: Error) => reason,
    );
    expect(error).toBeInstanceOf(MachineRefusal);
    if (!(error instanceof MachineRefusal)) throw new Error("expected a refusal");
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe(OFFICE_CACHE_UNAVAILABLE_REASON);

    // The target does not exist, and the directory the write would have used holds nothing new.
    expect(await readdir(join(root, "projects", "one"))).toStrictEqual([]);
  });
});

// Catches: a `source` write accepted with the bytes also in the body, which would leave the machine
// choosing which bytes are the file. The route test above starts with a parse, so this is the
// parse's half: it never becomes an operation.
test("a write naming both a content and a source does not parse", () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ ...sourceWrite, content: Buffer.from("hello").toString("base64") }),
  );
  expect(() => parseOperation(body)).toThrow(MachineRefusal);
});

// Catches: the office ops parsed as another op, or refused as unknown; and a `content` write's
// route changed by the source branch. Without an executor the job is answered the job's own way —
// `engine_unavailable`, which is the code the contract has for "this machine cannot do it" — and
// the probe says the same thing about the pack, rather than either failing as a defect.
test("the office ops parse and answer what this build can", async () => {
  await withRoot(async (root) => {
    const job = {
      v: 1,
      id: "office-1750",
      input: {
        workspaceId: "ws-1",
        path: "提案書.docx",
        version: sourceWrite.source.version,
        format: "docx",
      },
      limits: {
        maxInputBytes: 52428800,
        maxCells: 300000,
        maxPixels: 24000000,
        timeoutMs: 60000,
        maxOutputBytes: 104857600,
      },
      operation: "convert",
      to: "pdf",
    };
    const controller = new AbortController();

    const parsedOffice = parseOperation(
      new TextEncoder().encode(JSON.stringify({ op: "office", job })),
    );
    expect(parsedOffice.op).toBe("office");
    if (parsedOffice.op !== "office") throw new Error("expected an office job");
    const office = parsedOffice;
    const jobAnswer = await runOperation(office, root, DEFAULT_LIMITS, controller.signal);
    expect(jobAnswer).toStrictEqual({
      ok: false,
      error: "engine_unavailable",
      message: "the agent was started without an office engine",
    });

    const parsedProbe = parseOperation(new TextEncoder().encode('{"op":"officeEngine"}'));
    expect(parsedProbe.op).toBe("officeEngine");
    if (parsedProbe.op !== "officeEngine") throw new Error("expected a probe");
    const probe = parsedProbe;
    expect(await runOperation(probe, root, DEFAULT_LIMITS, controller.signal)).toStrictEqual({
      available: false,
      reason: "no office pack is installed on this machine",
    });

    // The content write is unchanged: the same route still writes the bytes.
    await writeFile(join(root, "projects", "one", ".keep"), "");
    const content = {
      op: "write",
      projectRoot: "projects/one",
      path: "a.txt",
      expectedVersion: "absent",
      operationId: "op-1754",
      // The real digest of "hello": the machine checks the bytes against the intent's hash.
      contentHash: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      content: Buffer.from("hello").toString("base64"),
    };
    const parsedWrite = parseOperation(new TextEncoder().encode(JSON.stringify(content)));
    if (parsedWrite.op !== "write") throw new Error("expected a write");
    const answer = await runOperation(parsedWrite, root, DEFAULT_LIMITS, controller.signal);
    // The content route is unchanged by the source branch: it still writes the bytes.
    expect(answer).toStrictEqual({
      status: "applied",
      operationId: "op-1754",
      version: content.contentHash,
      path: "projects/one/a.txt",
    });
  });
});

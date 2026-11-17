import { createHash } from "node:crypto";
import type {
  CheckpointPrepareResult,
  MachineReadResult,
  MachineRefusalCode,
  MachineWriteRequest,
  MachineWriteResult,
} from "@hns/core";
import { checkpointPackKey } from "@hns/workspace/objects";
import type { MachineCall, MachineFiles, MachineFilesAnswer } from "../../src/do/machine.ts";

/** The sha256 version of some text, in the spelling the workspace uses. */
export function versionOfText(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

/** base64 of some text, the wire spelling of a write's content. */
export function base64Of(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** One write the fake was asked to apply. */
type FakeWrite = MachineWriteRequest;

/**
 * A machine that keeps its files in memory.
 *
 * @remarks
 * It implements the same contract the real agent does: the current content's hash is compared
 * with `expectedVersion`, its own content is `applied` on a retry, and a mismatch is
 * `conflict`. A caller can seed a file behind the Workspace's back (an agent's shell), make the
 * next answer a transport failure, or make the next write a definite refusal. Writes run one at
 * a time, as the machine's concurrency limit makes them.
 */
export interface FakeMachine extends MachineFiles {
  readonly writes: FakeWrite[];
  readonly reads: string[];
  /** Put a file in the machine, as an outside writer (an agent's shell) would. */
  seed(path: string, content: string): void;
  /** Put arbitrary bytes in the machine, for a read the face must not decode as text. */
  seedRaw(path: string, base64: string): void;
  /** The content the machine holds, or undefined. */
  contentOf(path: string): string | undefined;
  /** Make the next answer a transport failure. */
  failNext(): void;
  /** Make the next answer a definite refusal with this code. */
  denyNext(refusal: MachineRefusalCode): void;
  /** Make the next answer a too-large refusal (the file or the body is beyond the bound). */
  tooLargeNext(): void;
  /** The checkpoint answers this fake gave, in order. */
  readonly checkpoints: string[];
  /**
   * What the next checkpoint answers, or `"fail"` for a transport failure.
   *
   * @remarks
   * The checkpoint is a metadata answer (the commit, the pack's key, the sizes), so the fake
   * builds it without a repository. A test that needs a particular commit or size sets it here.
   */
  checkpointNext(answer: FakeCheckpoint | "fail"): void;
}

/** What the fake machine's checkpoint answers with, apart from the identity it fills in. */
interface FakeCheckpoint {
  readonly commit: string;
  readonly objectCount?: number;
  readonly packBytes?: number;
  readonly maxBlobBytes?: number;
  readonly created?: boolean;
}

/**
 * Create the fake machine.
 *
 * @returns A {@link FakeMachine} with no files.
 */
export function fakeMachine(): FakeMachine {
  const files = new Map<string, string>();
  const raw = new Map<string, string>();
  const writes: FakeWrite[] = [];
  const reads: string[] = [];
  const checkpoints: string[] = [];
  let checkpoint: FakeCheckpoint | "fail" | undefined;
  let failNext = false;
  let denial: MachineRefusalCode | undefined;
  let tooLarge = false;
  let queue: Promise<void> = Promise.resolve();

  /** Run one write after the previous one, so the compare-and-write is serialized. */
  async function serialized<T>(work: () => T): Promise<T> {
    const result = queue.then(() => work());
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  function failure(
    failureKind: "denied" | "too_large" | "unavailable",
    detail: string,
    refusal?: MachineRefusalCode,
  ) {
    return { ok: false as const, failure: failureKind, detail, refusal };
  }

  return {
    writes,
    reads,
    checkpoints,
    checkpointNext(answer) {
      checkpoint = answer;
    },
    seed(path, content) {
      files.set(path, content);
      raw.delete(path);
    },
    seedRaw(path, base64) {
      raw.set(path, base64);
      files.delete(path);
    },
    contentOf(path) {
      return files.get(path);
    },
    failNext() {
      failNext = true;
    },
    denyNext(refusal) {
      denial = refusal;
    },
    tooLargeNext() {
      tooLarge = true;
    },
    async write(
      request: MachineWriteRequest,
      _call: MachineCall,
    ): Promise<MachineFilesAnswer<MachineWriteResult>> {
      writes.push(request);
      return await serialized(() => {
        if (failNext) {
          failNext = false;
          return failure("unavailable", "test transport failure");
        }
        if (tooLarge) {
          tooLarge = false;
          return failure("too_large", "too_large", "too_large");
        }
        if (denial !== undefined) {
          const detail = denial;
          denial = undefined;
          return failure("denied", detail, detail);
        }
        const key =
          request.projectRoot === "" ? request.path : request.projectRoot + "/" + request.path;
        const content = Buffer.from(request.content, "base64").toString("utf8");
        if (versionOfText(content) !== request.contentHash) {
          return failure("denied", "invalid_request", "invalid_request");
        }
        const current = files.get(key);
        if (current !== undefined && versionOfText(current) === request.contentHash) {
          return {
            ok: true as const,
            result: {
              status: "applied" as const,
              operationId: request.operationId,
              version: request.contentHash,
              path: key,
            },
          };
        }
        const currentVersion = current === undefined ? "absent" : versionOfText(current);
        if (currentVersion !== request.expectedVersion) {
          return {
            ok: true as const,
            result: {
              status: "conflict" as const,
              operationId: request.operationId,
              currentVersion,
              path: key,
            },
          };
        }
        files.set(key, content);
        return {
          ok: true as const,
          result: {
            status: "applied" as const,
            operationId: request.operationId,
            version: request.contentHash,
            path: key,
          },
        };
      });
    },
    async read(
      request: { readonly path: string },
      _call: MachineCall,
    ): Promise<MachineFilesAnswer<MachineReadResult>> {
      reads.push(request.path);
      if (failNext) {
        failNext = false;
        return failure("unavailable", "test transport failure");
      }
      if (tooLarge) {
        tooLarge = false;
        return failure("too_large", "too_large", "too_large");
      }
      const encoded = raw.get(request.path);
      if (encoded !== undefined) {
        const bytes = Buffer.from(encoded, "base64");
        return {
          ok: true as const,
          result: {
            path: request.path,
            size: bytes.byteLength,
            version: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
            content: encoded,
          },
        };
      }
      const content = files.get(request.path);
      if (content === undefined) return failure("denied", "not_found", "not_found");
      const bytes = Buffer.from(content, "utf8");
      return {
        ok: true as const,
        result: {
          path: request.path,
          size: bytes.byteLength,
          version: versionOfText(content),
          content: bytes.toString("base64"),
        },
      };
    },
    async checkpoint(
      request: { readonly runId: string },
      _call: MachineCall,
    ): Promise<MachineFilesAnswer<CheckpointPrepareResult>> {
      checkpoints.push(request.runId);
      return await serialized(() => {
        if (checkpoint === "fail") {
          checkpoint = undefined;
          return failure("unavailable", "test transport failure");
        }
        const answer = checkpoint;
        checkpoint = undefined;
        // A deterministic commit per Run, so a test knows the key before it asks.
        const commit =
          answer?.commit ??
          createHash("sha1")
            .update("checkpoint:" + request.runId)
            .digest("hex");
        return {
          ok: true as const,
          result: {
            runId: request.runId,
            ref: "refs/hns/checkpoints/" + request.runId,
            commit,
            packKey: checkpointPackKey(commit),
            objectCount: answer?.objectCount ?? 1,
            packBytes: answer?.packBytes ?? 8,
            maxBlobBytes: answer?.maxBlobBytes ?? 4,
            created: answer?.created ?? true,
          },
        };
      });
    },
  };
}

import { createHash } from "node:crypto";
import type { MachineReadResult, MachineWriteRequest, MachineWriteResult } from "@hns/core";
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
export type FakeWrite = MachineWriteRequest;

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
  denyNext(refusal: string): void;
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
  let failNext = false;
  let denial: string | undefined;
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

  function failure(failureKind: "denied" | "unavailable", detail: string) {
    return { ok: false as const, failure: failureKind, detail };
  }

  return {
    writes,
    reads,
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
        if (denial !== undefined) {
          const detail = denial;
          denial = undefined;
          return failure("denied", detail);
        }
        const key =
          request.projectRoot === "" ? request.path : request.projectRoot + "/" + request.path;
        const content = Buffer.from(request.content, "base64").toString("utf8");
        if (versionOfText(content) !== request.contentHash) {
          return failure("denied", "invalid_request");
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
      if (content === undefined) return failure("denied", "not_found");
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
  };
}

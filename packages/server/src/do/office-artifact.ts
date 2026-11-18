import { MAX_ARTIFACT_BYTES } from "@hns/core/office";
import type { OfficeCacheKey } from "@hns/core/office";
import type { MachineCall, MachineFiles } from "./machine.ts";
/** What one artifact stream needs to read its bytes from the machine (0237, C8). */
export interface OfficeArtifactStream {
  /** The machine's port: this function calls its `readArtifact` only. */
  readonly machine: MachineFiles;
  /** The call's identity and deadline; a fresh one per range would change nothing here. */
  readonly call: MachineCall;
  /** The artifact's 5-tuple, as the row recorded it. */
  readonly key: OfficeCacheKey;
  /** The workspace-relative path: the machine derives its hash from this signed value (§5). */
  readonly path: string;
  /** The whole artifact's size, as the row recorded it. */
  readonly total: number;
  /** Aborted when the reader goes away (the browser closed the tab). */
  readonly signal: AbortSignal;
}

/**
 * Stream one artifact from the machine, one 8 MiB range at a time (0237, C8).
 *
 * @param request - The machine, the key, the size, and the reader's signal.
 * @returns A stream of the artifact's bytes, in order.
 *
 * @remarks
 * **The bytes are never in the Worker.** The preview may be tens of megabytes and the route's
 * job is to pass it on, so each range is asked for with the contract's one target builder
 * ({@link artifactTarget}), read as a chunk, and enqueued; the next range is asked for only when
 * the reader takes the previous one. A range the machine refuses ends the stream with an error,
 * which the runtime answers as a broken response rather than as a short file: a truncated PDF
 * that looked complete would be worse than no file.
 *
 * **No signed URL exists.** The signature covers the request target, and the target is built here
 * for the request this function makes; nothing hands a URL to a browser, so nothing can be
 * replayed by one.
 */
export function artifactStream(request: OfficeArtifactStream): ReadableStream<Uint8Array> {
  let offset = 0;
  let reading = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reading) return;
      reading = true;
      try {
        if (offset >= request.total) {
          controller.close();
          return;
        }
        if (request.signal.aborted) {
          controller.error(new Error("the reader went away"));
          return;
        }
        const length = Math.min(MAX_ARTIFACT_BYTES, request.total - offset);
        const answer = await request.machine.readArtifact?.(
          {
            workspaceId: request.key.workspaceId,
            path: request.path,
            version: request.key.version,
            operation: request.key.operation,
            paramsHash: request.key.paramsHash,
            offset,
            length,
          },
          request.call,
          request.signal,
        );
        if (answer === undefined || !answer.ok) {
          controller.error(new Error("the machine did not serve the artifact"));
          return;
        }
        const reader = answer.body.getReader();
        const chunk = await reader.read();
        await reader.cancel().catch(() => undefined);
        if (chunk.done === true || chunk.value.byteLength === 0) {
          controller.error(new Error("the machine answered no bytes"));
          return;
        }
        offset += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error) {
        // A failed range is a broken answer, never a short one: the response is cut, so a client
        // sees a truncated transfer rather than a PDF that ends early.
        controller.error(error instanceof Error ? error : new Error("the artifact read failed"));
      } finally {
        reading = false;
      }
    },
    cancel() {
      // Nothing to release: a range is one response the machine closes when it is read.
      offset = request.total;
    },
  });
}

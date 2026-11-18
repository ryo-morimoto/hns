/* oxlint-disable anti-slop/no-chained-type-assertions -- The subject is a port the stream calls
   through one member: the test builds that member and hands the stream the port, which is what a
   partial double is. The stream reads nothing else. */
import { expect, test } from "vitest";
import type { OfficeCacheKey } from "@hns/core/office";
import { officeParamsHash, officePathHash } from "@hns/core/office";
import { artifactStream } from "./office-artifact.ts";
import type { MachineFiles } from "./machine.ts";
/** The version of the artifact a test asks for. */
const VERSION = "sha256:" + "f".repeat(64);

/** The key of the artifact a test asks for. */
async function keyOf(): Promise<OfficeCacheKey> {
  return {
    workspaceId: "project-1",
    pathHash: await officePathHash("提案書.docx"),
    version: VERSION,
    operation: "preview",
    paramsHash: await officeParamsHash("preview", {}),
  };
}

/** The call the stream carries: a machine id, a correlation id, and a deadline. */
const call = {
  machineId: "machine-1",
  requestId: "request-1",
  signal: AbortSignal.timeout(30_000),
};

/**
 * A machine that serves one artifact from memory, in the 8 MiB ranges the contract names.
 *
 * @param total - The artifact's size.
 * @returns The port, and the ranges it was asked for.
 */
function machineServing(total: number) {
  const ranges: { readonly offset: number; readonly length: number }[] = [];
  const machine = {
    async readArtifact(request: {
      readonly offset?: number | undefined;
      readonly length?: number | undefined;
    }) {
      const offset = request.offset ?? 0;
      const length = request.length ?? 0;
      ranges.push({ offset, length });
      return {
        ok: true as const,
        status: 206,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(length).fill(offset % 251));
            controller.close();
          },
        }),
        length,
        contentRange: `bytes ${offset}-${offset + length - 1}/${total}`,
      };
    },
  };
  return {
    // SAFETY: the stream calls exactly this one member of the port; the rest belong to writes
    // and reads the stream never makes.
    machine: machine as unknown as MachineFiles,
    ranges,
  };
}

// Catches: the route collecting the whole preview before answering (C8): a 31 MB artifact must
// cross as 8 MiB ranges, and no chunk may be the whole file.
test("a 31 MB artifact streams in 8 MiB ranges", async () => {
  const total = 31 * 1024 * 1024;
  const { machine, ranges } = machineServing(total);
  const stream = artifactStream({
    machine,
    call,
    key: await keyOf(),
    path: "提案書.docx",
    total,
    signal: new AbortController().signal,
  });
  const reader = stream.getReader();
  const sizes: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sizes.push(value.byteLength);
  }
  // Four ranges: 8 + 8 + 8 + 7 MiB.
  expect(sizes).toStrictEqual([8, 8, 8, 7].map((mib) => mib * 1024 * 1024));
  expect(ranges.map((range) => range.offset)).toStrictEqual([
    0,
    8 * 1024 * 1024,
    16 * 1024 * 1024,
    24 * 1024 * 1024,
  ]);
  expect(Math.max(...sizes)).toBeLessThan(total);
});

// Catches: a range the machine refuses ending the stream as a short, complete-looking file: it
// ends with an error instead, so a browser gets a broken response rather than a truncated PDF.
test("a refused range ends the stream with an error", async () => {
  const machine = {
    async readArtifact() {
      return { ok: false as const, detail: "404" };
    },
  };
  const stream = artifactStream({
    // SAFETY: the stream calls exactly `readArtifact`, which this port defines.
    machine: machine as unknown as MachineFiles,
    call,
    key: await keyOf(),
    path: "提案書.docx",
    total: 10,
    signal: new AbortController().signal,
  });
  await expect(stream.getReader().read()).rejects.toThrow("did not serve");
});

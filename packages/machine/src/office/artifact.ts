import { stat } from "node:fs/promises";
import {
  MAX_ARTIFACT_BYTES,
  artifactTarget,
  officeArtifactContentType,
  officePathHash,
  parseArtifactQuery,
} from "@hns/core/office";
import type { ArtifactAnswer, ArtifactQuery, OfficeArtifactFileOperation } from "@hns/core/office";
import { MachineRefusal } from "../refusal.ts";
import { open } from "node:fs/promises";
import type { OfficeCacheKey } from "@hns/core/office";
import type { OfficeCache } from "./cache.ts";

/**
 * One served `GET /artifact` answer: the metadata, and the bytes to write.
 *
 * @remarks
 * The bytes are the range the request asked for, already read; the agent writes them and is done.
 * They are read here rather than streamed because the range is bounded at 8 MiB, which is what
 * makes one read safe to hold for the length of one response.
 */
export interface ArtifactResponse {
  readonly answer: ArtifactAnswer;
  readonly bytes: Uint8Array;
}

/**
 * The query this machine would sign for one request target, or the refusal that rejects it.
 *
 * @param target - The request target as it arrived: `/artifact?…`, query included.
 * @returns The parsed query when it is the canonical spelling of itself.
 * @throws {MachineRefusal} `invalid_request` for a target that is not `/artifact` with a query, a
 * query with an unknown, repeated or malformed pair, a `length` over {@link MAX_ARTIFACT_BYTES},
 * or a query that is valid but not the one spelling of itself.
 *
 * @remarks
 * **The signature covers the whole request target** (`docs/office.md` §5): the verifier hashes the
 * path and query the client sent, so the machine only has to check that what it received is the
 * canonical target for what it parsed. A query whose pairs were reordered, whose encoding was
 * different, or whose `version` was swapped for another still parses, and is refused here — before
 * the signature is even attempted — because it is not the target anybody signed.
 *
 * The `path` and `operation` pairs are not trusted for what they say: the cache path is built from
 * `officePathHash(path)` and from an operation that makes a file, so a `pathHash` cannot be
 * smuggled in, and a `convert` (which makes no cache entry) is not a key this route serves.
 */
export function verifyArtifactTarget(target: string): ArtifactQuery {
  const question = target.indexOf("?");
  if (question === -1) {
    throw new MachineRefusal("invalid_request", "an artifact read names its key in the query");
  }
  const route = target.slice(0, question);
  const query = target.slice(question + 1);
  let entries: [string, string][];
  try {
    const parsed = new URLSearchParams(query);
    entries = [...parsed.entries()];
  } catch {
    throw new MachineRefusal("invalid_request", "the artifact query cannot be read");
  }
  let parsed: ArtifactQuery;
  try {
    parsed = parseArtifactQuery(entries);
  } catch (error) {
    throw new MachineRefusal(
      "invalid_request",
      error instanceof Error ? error.message : "the artifact query is not an artifact key",
    );
  }
  if (parsed.operation !== "preview" && parsed.operation !== "render") {
    throw new MachineRefusal(
      "invalid_request",
      "the artifact query names no artifact the cache holds",
    );
  }
  const canonical = artifactTarget({
    workspaceId: parsed.workspaceId,
    path: parsed.path,
    version: parsed.version,
    operation: parsed.operation,
    paramsHash: parsed.paramsHash,
    offset: parsed.offset,
    length: parsed.length,
  });
  if (canonical !== target) {
    throw new MachineRefusal("invalid_request", "the artifact target is not the signed one");
  }
  void route;
  return parsed;
}

/**
 * The cache key one query names, derived rather than taken.
 *
 * @param query - The verified query.
 * @returns Nothing; the query itself is the key, with `pathHash` derived from `path`.
 * @throws {MachineRefusal} `invalid_request` for an operation that makes no cache entry.
 *
 * @remarks
 * §5 says the machine must not trust `pathHash`: it computes it from the `path` the signature
 * covered, so a query whose `path` and `pathHash` disagree names the entry the `path` deserves.
 * The `workspaceId` is used as a directory name by {@link OfficeCache.path}, which refuses one
 * that is a path rather than a name; a workspace this machine never wrote simply has no entry.
 */
export async function artifactKeyOf(query: ArtifactQuery): Promise<OfficeCacheKey> {
  if (query.operation !== "preview" && query.operation !== "render") {
    throw new MachineRefusal(
      "invalid_request",
      "the artifact query names no artifact the cache holds",
    );
  }
  return {
    workspaceId: query.workspaceId,
    pathHash: await officePathHash(query.path),
    version: query.version,
    operation: query.operation,
    paramsHash: query.paramsHash,
  };
}

/**
 * Read one range of a cached artifact.
 *
 * @param cache - The machine's cache.
 * @param key - The 5-tuple the query was verified into.
 * @param query - The verified query, whose `offset` and `length` select the range.
 * @returns The answer's metadata and the bytes of the range that exists.
 * @throws {MachineRefusal} `not_found` when the cache has no such entry (the range is resolved
 * inside the cache and nowhere else: ROOT is never read), and `invalid_request` when the bytes on
 * disk are no longer the size the key was written with.
 *
 * @remarks
 * The whole artifact is the default range. A `length` over {@link MAX_ARTIFACT_BYTES} never reaches
 * here (the query refuses it), and an `offset` past the end answers an empty range at the end
 * rather than an error: it is a valid read of a valid key.
 */
export async function serveArtifact(
  cache: OfficeCache,
  key: OfficeCacheKey,
  query: ArtifactQuery,
  maxBytes: number,
): Promise<ArtifactResponse> {
  const path = cache.path(key);
  const hit = await cache.lookup(key);
  const info = hit === undefined ? undefined : await stat(path).catch(() => undefined);
  if (hit === undefined || info === undefined) {
    throw new MachineRefusal("not_found", "the cache holds no artifact for this key");
  }
  const total = info.size;
  const offset = Math.min(query.offset ?? 0, total);
  const length = Math.min(query.length ?? total - offset, total - offset, maxBytes);
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(Math.max(0, length));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    const body = bytes.subarray(0, bytesRead);
    return {
      answer: {
        length: body.byteLength,
        total,
        offset,
        contentType: officeArtifactContentType(operationOf(query)),
        contentRange:
          "bytes " +
          String(offset) +
          "-" +
          String(offset + body.byteLength - 1) +
          "/" +
          String(total),
      },
      bytes: body,
    };
  } finally {
    await handle.close();
  }
}

/** The operation, narrowed to the two that make a cache entry. */
function operationOf(query: ArtifactQuery): OfficeArtifactFileOperation {
  return query.operation === "render" ? "render" : "preview";
}

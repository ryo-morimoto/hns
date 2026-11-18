import { open, stat } from "node:fs/promises";
import {
  MACHINE_ARTIFACT_PATH,
  MAX_ARTIFACT_BYTES,
  officeArtifactContentType,
  officePathHash,
  parseArtifactQuery,
} from "@hns/core/office";
import type { ArtifactAnswer, ArtifactQuery, OfficeArtifactFileOperation } from "@hns/core/office";
import { MachineRefusal } from "../refusal.ts";
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
 * @returns The parsed key and the range the target names.
 * @throws {MachineRefusal} `invalid_request` for a target that is not `{@link MACHINE_ARTIFACT_PATH}`
 * with a query, a query with an unknown, repeated or malformed pair, a `length` over
 * {@link MAX_ARTIFACT_BYTES}, or a query that is valid but not the one spelling of itself.
 *
 * @remarks
 * **The signature covers the whole request target** (`docs/office.md` §5): the verifier hashes the
 * path and query the client sent, so the machine only has to check that what it received is the
 * canonical target for what it parsed. A query whose pairs were reordered or whose `version` was
 * swapped for another still parses, and is refused here — before the signature is even attempted —
 * because it is not the target anybody signed.
 *
 * **The query's shape is checked on the raw text, before anything is decoded**: the pairs must be
 * exactly the five key parts, in that order, followed by `offset` then `length` when the target
 * names them. That is the one order the server writes, so a reordered query, a repeated key, or a
 * range put before a key part is refused even though it parses. The values are proved after it, by
 * `parseArtifactQuery`, which is also what refuses a key part outside its spelling.
 *
 * The `operation` is not trusted for what it says: the cache path is built for an operation that
 * makes a file, so a `convert` (which makes no cache entry) is not a key this route serves.
 */
export function verifyArtifactTarget(target: string): ArtifactQuery {
  const question = target.indexOf("?");
  if (question === -1) {
    throw new MachineRefusal("invalid_request", "an artifact read names its key in the query");
  }
  if (target.slice(0, question) !== MACHINE_ARTIFACT_PATH) {
    throw new MachineRefusal("invalid_request", "an artifact read is not the artifact route");
  }
  const query = target.slice(question + 1);
  const pairs = rawPairs(query);
  // The pairs are checked first, on their raw text: the target must be the key's five parts and
  // then, if they are named, `offset` and `length`. A query that parses to the same values in
  // another order (or with a pair added somewhere else) is not the target anybody signed.
  if (!isCanonicalPairs(pairs)) {
    throw new MachineRefusal("invalid_request", "the artifact target is not the signed one");
  }
  let entries: [string, string][];
  try {
    entries = [...new URLSearchParams(query).entries()];
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
  return parsed;
}

/** The artifact query's key parts, in the order the canonical spelling writes them. */
const ARTIFACT_QUERY_KEYS = ["workspaceId", "path", "version", "operation", "paramsHash"] as const;

/**
 * The query's pairs exactly as they were written.
 *
 * @param query - The target's query, after the `?`.
 * @returns Each pair's name, in order, without decoding it.
 */
function rawPairs(query: string): readonly string[] {
  return query.split("&").map((pair) => {
    const equals = pair.indexOf("=");
    return equals === -1 ? pair : pair.slice(0, equals);
  });
}

/**
 * Whether the pairs are the canonical query's, in its order.
 *
 * @param names - The pair names, as they were written.
 * @returns True for the five key parts and then, if named, `offset` and `length`; false for any
 * other name, a repeat, an absent one, or the canonical names in another order.
 *
 * @remarks
 * The check is of the names alone: the values are `parseArtifactQuery`'s to prove, and what this
 * function adds is that the *shape* of the query is the one the server signs. An appended
 * `&length=10` fails here because a sixth key part is not where the range goes; a repeated
 * `workspaceId` fails because the fifth position must be `paramsHash`.
 */
function isCanonicalPairs(names: readonly string[]): boolean {
  const expected: string[] = [...ARTIFACT_QUERY_KEYS];
  if (names[expected.length] === "offset") expected.push("offset");
  if (names[expected.length] === "length") expected.push("length");
  return names.length === expected.length && expected.every((name, at) => names[at] === name);
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

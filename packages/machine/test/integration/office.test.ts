import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as v from "valibot";
import {
  DEFAULT_OFFICE_LIMITS,
  OfficeEngineReportSchema,
  OfficeResultSchema,
  artifactTarget,
  officeCachePath,
  officeParamsHash,
} from "@hns/core/office";
import type { OfficeJob, OfficeResult } from "@hns/core/office";
import { OperationIdSchema } from "@hns/core";
import type { OperationId } from "@hns/core";
import { bodyHash, parseResponseBody } from "../../src/index.ts";
import type { ResponseBody } from "../../src/index.ts";
import { withAgent } from "../support/machine.ts";
import type { AgentFixture, MachineCall } from "../support/machine.ts";
import type { ObsLogEntry } from "@hns/core";
import { signRequest } from "../support/control-plane.ts";

// The real pack, the real engine, and the real agent: one file that proves 0236 end to end, over
// the machine's own HTTP routes, its own executor, bubblewrap, and the pack that
// tools/office-pack/build.sh builds (0235).
//
// The pack is built once into this file's own temporary directory and shared by every scenario.
// Every other test in this repository that needs a pack builds its own; build.sh removes and
// recreates the cache's scratch tree, so two concurrent builds on one checkout corrupt each other
// (0235's follow-up), and one build per process is how this file keeps out of their way.

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const buildScript = join(root, "tools/office-pack/build.sh");
const packCache = process.env.IBIS_OFFICE_CACHE_DIR ?? join(root, ".cache/office-pack");
const fixture = join(root, "tools/office-pack/test/fixtures/ja.docx");
const requirePack = process.env.HNS_REQUIRE_OFFICE_PACK === "1";

/** The reason this host cannot build the pack, or undefined when it can. */
function missingPrerequisite(): string | undefined {
  for (const name of ["curl", "sha256sum", "unzip", "tar", "node"]) {
    if (spawnSync("sh", ["-c", "command -v " + name]).status !== 0) return name + " is not on PATH";
  }
  if (spawnSync("bwrap", ["--version"]).status !== 0) return "bwrap is not on PATH";
  for (const store of ["mesa", "vulkan-loader"]) {
    const found = spawnSync("sh", ["-c", "compgen -G '/nix/store/*-" + store + "-*' | head -n 1"], {
      encoding: "utf8",
    });
    if ((found.stdout ?? "").trim() === "") return "no " + store + " in /nix/store";
  }
  return undefined;
}

const skipReason = missingPrerequisite();
if (skipReason !== undefined && requirePack) {
  throw new Error("HNS_REQUIRE_OFFICE_PACK=1 but this host cannot build the pack: " + skipReason);
}

let work = "";
let pack = "";
/** Directories the pack was moved to, so the teardown removes them too. */
const packs: string[] = [];
const fixtureBytes = skipReason === undefined ? await readFile(fixture) : new Uint8Array();
const fixtureVersion = "sha256:" + createHash("sha256").update(fixtureBytes).digest("hex");

beforeAll(async () => {
  if (skipReason !== undefined) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "hns-machine-office-it-")));
  pack = join(work, "pack");
  execFileSync(buildScript, [], {
    env: { ...process.env, IBIS_OFFICE_PACK_DIR: pack, IBIS_OFFICE_CACHE_DIR: packCache },
    stdio: "pipe",
  });
  // The build writes the pack into a directory under the system temp dir, and the engine is then
  // bound read-only from that path. A temporary directory that a *second* tmpfs is mounted over
  // inside the sandbox (the run's own directory tree) makes the loader resolve the pack's shared
  // objects differently: the engine starts alone and fails under bwrap (measured here). The pack
  // therefore lives beside the runs' directory tree, not above it, exactly as a deployment keeps
  // it outside the work area.
  const cacheHome = join(root, ".cache");
  await mkdir(cacheHome, { recursive: true });
  const beside = await realpath(await mkdtemp(join(cacheHome, "office-pack-it-")));
  const moved = join(beside, "pack");
  execFileSync("cp", ["-a", pack + "/.", moved]);
  await rm(pack, { recursive: true, force: true });
  pack = moved;
  packs.push(beside);
});

afterAll(async () => {
  for (const path of [work, ...packs]) {
    if (path !== "") await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});
/** The workspace every scenario names; the machine's ROOT is the only one it serves. */
const WORKSPACE = "ws-1";

/** The target one artifact read names: the key's parts, in the contract's one spelling. */
async function artifactOf(path: string, operation: "preview" | "render"): Promise<string> {
  return artifactTarget({
    workspaceId: WORKSPACE,
    path,
    version: fixtureVersion,
    operation,
    paramsHash: await officeParamsHash(operation, {}),
  });
}

/** One office job body, signed and sent as the Worker would. */
function officeCall(input: OfficeJob): MachineCall {
  return { body: JSON.stringify({ op: "office", job: input }) };
}

/** A job id, branded as the wire builds it. */
function jobId(value: string): OperationId {
  return v.parse(OperationIdSchema, value);
}

/** One office job: the fixture at `path`, previewed with the bounds the contract ships. */
function previewJob(path: string): OfficeJob {
  return {
    v: 1,
    id: jobId("office-1750"),
    input: { workspaceId: WORKSPACE, path, version: fixtureVersion, format: "docx" },
    // The defaults are the contract's own (DEFAULT_OFFICE_LIMITS), which is what the server sends.
    limits: DEFAULT_OFFICE_LIMITS,
    operation: "preview",
  };
}

/** One conversion of the fixture at `path`, with the same bounds. */
function convertJob(path: string, version: string = fixtureVersion): OfficeJob {
  return {
    v: 1,
    id: jobId("office-1752"),
    input: { workspaceId: WORKSPACE, path, version, format: "docx" },
    limits: DEFAULT_OFFICE_LIMITS,
    operation: "convert",
    to: "pdf",
  };
}

/** The answer's body, which is the envelope the agent's response schema parses. */
function bodyOf(answer: { readonly body: unknown }): ResponseBody {
  return parseResponseBody(JSON.stringify(answer.body));
}

/** The office result of an answer that must have carried one, parsed at the boundary. */
function officeResultOf(answer: { readonly body: unknown }): OfficeResult {
  const body = bodyOf(answer);
  if (!body.ok) throw new Error("expected a success, got " + body.code);
  return v.parse(OfficeResultSchema, body.result);
}

/** Sign and send one `GET /artifact` at exactly this target. */
async function getArtifact(
  fixture: AgentFixture,
  target: string,
  options: { readonly unsigned?: boolean; readonly signedTarget?: string } = {},
): Promise<{ readonly status: number; readonly bytes: Uint8Array; readonly headers: Headers }> {
  const headers = new Headers();
  if (options.unsigned !== true) {
    // One timestamp and one nonce for the signature and the header: the verifier checks the
    // window against the header's timestamp and refuses a nonce it has already seen.
    const timestamp = String(Date.now());
    const nonce = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const signature = signRequest(
      {
        machineId: fixture.machineId,
        connection: "connection-1",
        seq: "1",
        timestamp,
        nonce,
        method: "GET",
        path: options.signedTarget ?? target,
        bodyHash: bodyHash(new Uint8Array(0)),
      },
      fixture.signingKey,
    );
    headers.set("x-hns-machine", fixture.machineId);
    headers.set("x-hns-connection", "connection-1");
    headers.set("x-hns-seq", "1");
    headers.set("x-hns-timestamp", timestamp);
    headers.set("x-hns-nonce", nonce);
    headers.set("x-hns-signature", signature);
  }
  const response = await fetch(fixture.origin + target, { method: "GET", headers });
  return {
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers,
  };
}

/** The `sha256:<hex>` of one file. */
async function hashOf(path: string): Promise<string> {
  return (
    "sha256:" +
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
  );
}

/**
 * A minimal `.xlsx` whose sheets declare the given dimensions.
 *
 * @param dimensions - One `<dimension ref>` per sheet (`A1:AE10000` is 31 columns x 10,000 rows).
 * @returns The zip's bytes: a content-types part, a workbook, and a sheet per entry.
 *
 * @remarks
 * The workbook only has to be a zip with `xl/worksheets/sheet1.xml` in it: the prescan reads that
 * file's dimension reference and nothing else, and the engine is never reached.
 */
async function workbook(dimensions: readonly string[]): Promise<Uint8Array> {
  const files = new Map<string, string>();
  files.set("[Content_Types].xml", CONTENT_TYPES_OF_XLSX);
  files.set("xl/workbook.xml", WORKBOOK);
  dimensions.forEach((dimension, index) => {
    files.set(
      "xl/worksheets/sheet" + String(index + 1) + ".xml",
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="' +
        dimension +
        '"/><sheetData/></worksheet>',
    );
  });
  return zipOf(files);
}

/**
 * A `.docx` whose main part embeds an external relationship, as an external image would.
 *
 * @param url - The target the relationship names.
 * @returns The zip's bytes.
 *
 * @remarks
 * The engine resolves a relationship with `TargetMode="External"` by name, and nothing stops it
 * from trying to fetch it; the sandbox's `--unshare-net` is what makes that fetch fail inside the
 * network namespace instead of reaching the internet (C9).
 */
async function docxWithLink(url: string): Promise<Uint8Array> {
  const files = new Map<string, string>();
  files.set("[Content_Types].xml", CONTENT_TYPES_OF_DOCX);
  files.set("_rels/.rels", DOCX_RELATIONSHIPS);
  files.set(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' +
      url +
      '" TargetMode="External"/></Relationships>',
  );
  files.set(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>外部の画像を参照する段落</w:t></w:r></w:p></w:body></w:document>',
  );
  return zipOf(files);
}

/**
 * A `.docx` whose one part declares 600 MiB uncompressed.
 *
 * @returns The archive's bytes: a deflated entry, so the file on disk stays small.
 *
 * @remarks
 * The declared size is what the prescan reads from the central directory; deflating a long run of
 * one byte keeps the bytes on disk cheap while the claim is the one a decompression bomb makes.
 */
/**
 * A `.docx` whose one part declares far more than the machine's expansion bound.
 *
 * @returns The archive's bytes: two stored entries whose declared sizes add up past 2 GiB, each
 * small on disk.
 *
 * @remarks
 * The declared size is what a zip reader trusts, and this fixture's entries are stored (method
 * 0), so the claim is all the archive carries: no decompressor is asked to produce 600 MiB for a
 * test, and what the prescan reads is exactly the field a bomb lies in.
 */
/**
 * A `.docx` whose parts declare far more than the machine's expansion bound.
 *
 * @returns The archive's bytes: one stored entry that declares 700 MiB, with a single byte on
 * disk.
 *
 * @remarks
 * The declared size is what a zip reader trusts, and these entries are stored (method 0), so the
 * claim is all the archive carries: no decompressor is asked to produce 600 MiB for a test, and
 * what the prescan reads is exactly the field a bomb lies in. The CRCs are the values of the runs
 * the entries claim, computed with the arithmetic the fixture's own checksum uses.
 */
async function bomb(): Promise<Uint8Array> {
  const part = 700 * 1024 * 1024;
  const filler = new Uint8Array([0]);
  return zipDeflated([{ name: "word/media.bin", data: filler, uncompressed: part, method: 0 }]);
}

const CONTENT_TYPES_OF_XLSX =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const WORKBOOK =
  '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>';
const CONTENT_TYPES_OF_DOCX =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const DOCX_RELATIONSHIPS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

/**
 * Build a stored zip from names and their text, with a real central directory.
 *
 * @param files - The names and their UTF-8 text.
 * @returns The archive's bytes, which `node:zlib` and the prescan both read.
 *
 * @remarks
 * Every entry is stored (method 0), so the archive is as readable as the prescan's reader expects
 * and no deflate implementation has to be involved in a fixture. The CRCs are the real ones, so a
 * tool that checks them agrees with the archive.
 */
function zipOf(files: ReadonlyMap<string, string>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const data = new TextEncoder().encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    local.set([0x50, 0x4b, 0x03, 0x04], 0);
    write16(local, 4, 20);
    write16(local, 8, 0);
    write16(local, 12, 0x21);
    write32(local, 14, crc);
    write32(local, 18, data.length);
    write32(local, 22, data.length);
    write16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    central.set([0x50, 0x4b, 0x01, 0x02], 0);
    write16(central, 4, 20);
    write16(central, 6, 20);
    write16(central, 12, 0x21);
    write32(central, 16, crc);
    write32(central, 20, data.length);
    write32(central, 24, data.length);
    write16(central, 28, nameBytes.length);
    write32(central, 42, offset);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((total, central) => total + central.length, 0);
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06], 0);
  write16(end, 8, files.size);
  write16(end, 10, files.size);
  write32(end, 12, directory);
  write32(end, 16, offset);
  const zip = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of new Array<Uint8Array>().concat(locals, centrals, [end])) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

/** Write a 16-bit little-endian value. */
function write16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
}

/** Write a 32-bit little-endian value. */
function write32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/**
 * Build a zip whose entries are already deflated, with the declared sizes they will expand to.
 *
 * @param entries - The names, the deflated bytes, and the uncompressed size each claims.
 * @returns The archive's bytes.
 */
function zipDeflated(
  entries: readonly {
    readonly name: string;
    readonly data: Uint8Array;
    readonly uncompressed: number;
    /** 0 stores, 8 deflates; stored is what a fixture uses when it only claims a size. */
    readonly method?: number | undefined;
  }[],
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32OfZeros(entry.uncompressed);
    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    local.set([0x50, 0x4b, 0x03, 0x04], 0);
    write16(local, 4, 20);
    write16(local, 8, 8);
    write16(local, 12, 0x21);
    write32(local, 14, crc);
    write32(local, 18, entry.data.length);
    write32(local, 22, entry.uncompressed);
    write16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    central.set([0x50, 0x4b, 0x01, 0x02], 0);
    write16(central, 4, 20);
    write16(central, 6, 20);
    write16(central, 10, 8);
    write16(central, 12, 0x21);
    write32(central, 16, crc);
    write32(central, 20, entry.data.length);
    write32(central, 24, entry.uncompressed);
    write16(central, 28, nameBytes.length);
    write32(central, 42, offset);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((total, central) => total + central.length, 0);
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06], 0);
  write16(end, 8, entries.length);
  write16(end, 10, entries.length);
  write32(end, 12, directory);
  write32(end, 16, offset);
  const zip = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of new Array<Uint8Array>().concat(locals, centrals, [end])) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

/** The CRC-32 of a run of zero bytes, which is what {@link bomb}'s entries declare. */
function crc32OfZeros(length: number): number {
  return crc32Of(new Uint8Array([0]), length);
}

/**
 * The CRC-32 a zip entry carries.
 *
 * @param bytes - The entry's bytes.
 * @returns The IEEE 802.3 polynomial's value, starting from 0xffffffff.
 *
 * @remarks
 * Written out rather than taken from `zlib.crc32`: the fixture's archive has to be one a plain zip
 * reader accepts, and the value is the same polynomial every reader checks.
 */
function crc32(bytes: Uint8Array): number {
  return crc32Of(bytes, 1);
}

/**
 * The CRC-32 of a byte repeated, without materialising the run.
 *
 * @param pattern - The bytes to repeat.
 * @param times - How many times.
 * @returns The checksum of the whole run.
 *
 * @remarks
 * {@link bomb} declares an entry that expands to 600 MiB; its checksum is computed from the
 * pattern rather than from a 600 MiB buffer nobody needs.
 */
function crc32Of(pattern: Uint8Array, times: number): number {
  let crc = 0xffffffff;
  for (let round = 0; round < times; round += 1) {
    for (const byte of pattern) {
      crc = ((crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The CRC-32 lookup table, 256 entries of the IEEE 802.3 polynomial.
 *
 * @remarks
 * Built once, because {@link crc32OfZeros} runs it over gigabytes for {@link bomb} and the bitwise
 * form is ten seconds of a test run. The values are the polynomial's, computed here rather than
 * copied.
 */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

/** The office options every scenario starts the agent with. */
function officeSetup(
  overrides: { readonly packRoot?: string | undefined; readonly bwrap?: string | undefined } = {},
) {
  return {
    packRoot: overrides.packRoot ?? pack,
    bwrap: overrides.bwrap,
  };
}

/**
 * Run one scenario against a fresh ROOT that holds the fixture, and a fresh cache.
 *
 * @param run - The scenario, given the running agent and the paths it may use.
 * @param overrides - A pack other than the one this file built, or a bwrap that is not there.
 *
 * @remarks
 * The cache, the runs, and the log are per scenario: two scenarios that shared them would share
 * entries (a second job would answer `cached: true` when the first had not run), and the log is
 * kept so a failure can say what the agent recorded without turning every scenario verbose.
 */
async function withOffice(
  run: (fixture: AgentFixture, logs: ObsLogEntry[]) => Promise<void>,
  overrides: { readonly packRoot?: string | undefined; readonly bwrap?: string | undefined } = {},
): Promise<void> {
  const logs: ObsLogEntry[] = [];
  try {
    await withAgent(
      async ({ root }) => {
        await writeFile(join(root, "proposal.docx"), fixtureBytes);
      },
      async (fixture) => {
        await run(fixture, logs);
      },
      // The cache and the runs default to the agent's own directories (outside ROOT), so each
      // scenario starts with an empty cache and a fresh runs' directory.
      { office: officeSetup(overrides), onLog: (line) => logs.push(line) },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason + " (the agent's log: " + JSON.stringify(logs) + ")");
  }
}

/**
 * The office cache directory a scenario's agent uses.
 *
 * @param fixture - The running agent, whose runs' directory is its own temporary one.
 * @returns `<base>/cache`, which is what `withAgent` makes for every scenario.
 *
 * @remarks
 * The agent's runs' directory is made under the system temp dir and removed on close, so the
 * cache is found beside the fixture's base rather than under it. The path is spelled here once
 * because two scenarios ask for a file in it.
 */
function cacheRootOf(fixture: AgentFixture): string {
  return join(fixture.base, "office-cache");
}

/** A directory tree as sorted relative paths, so "nothing changed" is one comparison. */
async function treeOf(path: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      found.push(relative);
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
    }
  };
  await walk(path, "");
  return found.sort();
}

describe.skipIf(skipReason !== undefined)("the office engine over the real pack", () => {
  // C1 and C2: a document over a bound is answered before anything runs. The engine would take
  // minutes on it; the job is answered in milliseconds, which is the observable difference.
  test("C1 / C2: an over-large workbook is refused without running the engine", async () => {
    await withAgent(
      async ({ root }) => {
        // A real .xlsx: the smallest zip Office reads, whose one sheet declares a huge dimension.
        await writeFile(join(root, "huge.xlsx"), await workbook(["A1:AE10000"]));
      },
      async (fixture) => {
        const started = Date.now();
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "office",
            job: {
              ...previewJob("huge.xlsx"),
              input: {
                workspaceId: WORKSPACE,
                path: "huge.xlsx",
                version: await hashOf(join(fixture.root, "huge.xlsx")),
                format: "xlsx",
              },
            },
          }),
        });
        const took = Date.now() - started;
        const result = officeResultOf(answer);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe("too_many_cells");
        // The engine takes tens of seconds on a workbook this size; a prescan takes milliseconds.
        expect(took).toBeLessThan(5_000);
      },
      { office: officeSetup() },
    );
  });

  // C4: the second job of the same document answers from the cache and runs nothing. The proof is
  // the stats, and the proof of the stats is that the second call is an order of magnitude faster.
  test("C4: the same job twice generates once and answers cached the second time", async () => {
    await withOffice(async (fixture) => {
      const first = officeResultOf(await fixture.call(officeCall(previewJob("proposal.docx"))));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.stats.cached).toBe(false);
      expect(first.stats.peakRssMb).toBeGreaterThan(0);
      expect(first.artifact.file).toBe("pdf");
      expect(first.artifact.pages).toBeGreaterThanOrEqual(1);
      expect(first.artifact.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);

      const started = Date.now();
      const second = officeResultOf(await fixture.call(officeCall(previewJob("proposal.docx"))));
      const took = Date.now() - started;
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.stats.cached).toBe(true);
      expect(second.stats.ms).toBe(0);
      expect(second.artifact.sha256).toBe(first.artifact.sha256);
      expect(second.artifact.bytes).toBe(first.artifact.bytes);
      expect(took).toBeLessThan(2_000);
    });
  });

  // C8: a conversion writes the cache and nothing of ROOT, and answers the key its PDF is under.
  test("C8: convert caches the PDF and leaves ROOT untouched", async () => {
    await withOffice(async (fixture) => {
      const before = await treeOf(fixture.root);
      const answer = officeResultOf(await fixture.call(officeCall(convertJob("proposal.docx"))));
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.artifact.file).toBe("pdf");
      expect(answer.artifact.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(await treeOf(fixture.root)).toStrictEqual(before);
      // The PDF is in the cache, at the key the answer named.
      const cached = officeCachePath(answer.artifact.key);
      const onDisk = join(cacheRootOf(fixture), cached);
      const info = await stat(onDisk);
      expect(info.size).toBe(answer.artifact.bytes);
    });
  });

  // C6: no bwrap is no engine. The probe finds nothing to run it in, and the job is answered with
  // the code that says so instead of running unfenced.
  test("C6: without bubblewrap the job is engine_unavailable", async () => {
    await withAgent(
      async ({ root }) => {
        await writeFile(join(root, "proposal.docx"), fixtureBytes);
      },
      async (fixture) => {
        const answer = await fixture.call(officeCall(previewJob("proposal.docx")));
        const result = officeResultOf(answer);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe("engine_unavailable");
      },
      { office: officeSetup({ bwrap: join(work, "no-such-bwrap") }) },
    );
  });

  // C5: a job whose version is not the file's is refused before anything runs.
  test("C5: a version the file no longer has is source_changed", async () => {
    await withOffice(async (fixture) => {
      const job = previewJob("proposal.docx");
      const result = officeResultOf(
        await fixture.call(
          officeCall({ ...job, input: { ...job.input, version: "sha256:" + "0".repeat(64) } }),
        ),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("source_changed");
    });
  });

  // C3: a job that cannot finish inside its budget is cut off, and the answer says so. The engine
  // is given ten milliseconds, which is less than it needs to start.
  test("C3: a one-millisecond job budget is engine_timeout", async () => {
    await withOffice(async (fixture) => {
      const job = previewJob("proposal.docx");
      const started = Date.now();
      const result = officeResultOf(
        await fixture.call({
          body: JSON.stringify({
            op: "office",
            job: { ...job, limits: { ...job.limits, timeoutMs: 1 } },
          }),
        }),
      );
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("engine_timeout");
      // Nothing was left behind: the cache holds no entry for the job that timed out.
      const cached = await readdir(join(cacheRootOf(fixture), "")).catch(() => []);
      expect(cached).toStrictEqual([]);
    });
  });

  // C9: the engine runs with no network. A document that names an external target converts, and
  // the network namespace is what makes that harmless; the engine argv is where it is visible.
  test("C9: the engine's sandbox has no network, and an external link still converts", async () => {
    const { engineArgv, loadPack } = await import("../../src/office/index.ts");
    const loaded = await loadPack(pack);
    if (!loaded.ok) throw new Error(loaded.reason);
    const argv = engineArgv(
      {
        pack: loaded.pack,
        binds: [],
        input: "/tmp/run/input.docx",
        operation: "convert",
        work: "/tmp/run",
        workRoot: "/tmp",
        timeoutMs: 1_000,
        maxRssMb: 256,
        maxOutputBytes: 1024,
      },
      {
        binary: join(pack, "bin/ibisOffice"),
        input: "/tmp/run/input.docx",
        output: "/tmp/run/out",
        bwrap: "bwrap",
      },
    );
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--clearenv");
    // The pack is bound read-only and the run directory writable; nothing of the host is writable.
    const packBind = argv.indexOf(pack);
    expect(argv[packBind - 1]).toBe("--ro-bind");

    await withOffice(async (fixture) => {
      await writeFile(
        join(fixture.root, "linked.docx"),
        await docxWithLink("https://example.invalid/x.png"),
      );
      const version = await hashOf(join(fixture.root, "linked.docx"));
      const result = officeResultOf(
        await fixture.call(officeCall(convertJob("linked.docx", version))),
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  });

  // C7 / C15: one job runs at a time, and the probe answers while it does. The first job is a
  // conversion (seconds of engine); the second is sent while it runs.
  test("C7 / C15: a second job is engine_busy while the probe still answers", async () => {
    await withOffice(async (fixture) => {
      const running = fixture.call(officeCall(convertJob("proposal.docx")));
      // Wait until the slot is taken: the probe is what tells the machine apart from an idle one.
      let busy = false;
      for (let attempt = 0; attempt < 200 && !busy; attempt += 1) {
        const probe = await fixture.call({ body: '{"op":"officeEngine"}' });
        expect(probe.body.ok).toBe(true);
        if (probe.body.ok) {
          const engine = v.parse(OfficeEngineReportSchema, probe.body.result);
          expect(engine.available).toBe(true);
          if (engine.available) {
            expect(engine.id).toBe("ibisoffice");
            expect(engine.operations).toContain("convert");
          }
        }
        const second = await fixture.call(officeCall(previewJob("proposal.docx")));
        if (!second.body.ok && second.body.code === "busy") busy = true;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(busy).toBe(true);
      const first = officeResultOf(await running);
      expect(first.ok, JSON.stringify(first)).toBe(true);
    });
  });

  // C11 / C13 / C14 and the artifact route itself: the bytes are served from the cache, the
  // signature covers the whole target, and a query that was rewritten is refused.
  test("C11 / C13 / C14: GET /artifact serves the cache, and only the signed target", async () => {
    await withOffice(async (fixture) => {
      const generated = officeResultOf(await fixture.call(officeCall(previewJob("proposal.docx"))));
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      const target = await artifactOf("proposal.docx", "preview");

      const served = await getArtifact(fixture, target);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("application/pdf");
      expect(served.bytes.byteLength).toBe(generated.artifact.bytes);
      expect("sha256:" + createHash("sha256").update(served.bytes).digest("hex")).toBe(
        generated.artifact.sha256,
      );

      // C13: no signature at all, on a key the cache holds (so "unsigned" cannot be reported as
      // "not in the cache", which is what an unsigned read of a missing key would look like).
      const unsigned = await getArtifact(fixture, target, { unsigned: true });
      expect(unsigned.status).toBe(401);

      // C14: the query rewritten after it was signed. The request goes to the honest target, is
      // signed as one key, and the bytes on the wire name another (a rewritten `paramsHash`):
      // the signature covers the request target the client sent, so a rewritten query is not the
      // one that was signed and the answer is 401.
      const paramsHash = await officeParamsHash("preview", {});
      const rewritten = target.replace(paramsHash, "0123456789abcdef");
      expect(rewritten).not.toBe(target);
      const tampered = await getArtifact(fixture, rewritten, { signedTarget: target });
      expect(tampered.status).toBe(401);
      // The same rewritten query, signed as itself, is a well-formed key that is not in the cache:
      // the target is canonical, so it is not a 401, and the cache holds nothing under it.
      const wellFormed = await getArtifact(fixture, rewritten, { signedTarget: rewritten });
      expect(wellFormed.status).toBe(404);

      // C11: a range over 8 MiB is refused at the query, before anything is read.
      const tooLong = target + "&length=10485760";
      const overRange = await getArtifact(fixture, tooLong);
      expect(overRange.status).toBe(400);

      // A different key is not in the cache: the route reads the cache, and only the cache.
      const miss = await getArtifact(fixture, await artifactOf("absent.docx", "preview"));
      expect(miss.status).toBe(404);

      // A range is served as the range it asked for.
      const range = await getArtifact(fixture, target + "&offset=0&length=1024");
      expect(range.status).toBe(200);
      expect(range.bytes.byteLength).toBe(1024);
      expect(range.headers.get("content-range")).toBe(
        "bytes 0-1023/" + String(generated.artifact.bytes),
      );
      expect(range.bytes).toStrictEqual(served.bytes.subarray(0, 1024));
    });
  });

  // The prescan's expansion bound: an archive that unpacks to far more than it stores is refused
  // before it is unpacked. The fixture is a .docx whose one part declares 700 MiB on disk as one
  // byte, so nothing about the engine or the layout is involved.
  test("an archive that expands past the bound is refused without running", async () => {
    await withAgent(
      async ({ root }) => {
        await writeFile(join(root, "bomb.docx"), await bomb());
      },
      async (fixture) => {
        const version = await hashOf(join(fixture.root, "bomb.docx"));
        const started = Date.now();
        const result = officeResultOf(
          await fixture.call(
            officeCall({
              ...previewJob("bomb.docx"),
              input: { workspaceId: WORKSPACE, path: "bomb.docx", version, format: "docx" },
            }),
          ),
        );
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // §9's table gives an archive that expands past the bound its own code; the machine's
        // message names an entry and the bound.
        expect(result.error).toBe("input_too_large_archive");
        expect(result.message).toContain("word/");
      },
      { office: officeSetup() },
    );
  });

  // The route does not read ROOT: a workspace file whose bytes happen to be cached is not served
  // under another name, because the path is part of the key and the bytes come from the cache
  // alone.
  test("the artifact route resolves the cache key and never ROOT", async () => {
    await withOffice(async (fixture) => {
      const generated = officeResultOf(await fixture.call(officeCall(previewJob("proposal.docx"))));
      expect(generated.ok).toBe(true);
      // A file in ROOT that a key could name.
      await writeFile(join(fixture.root, "secret.pdf"), "%PDF-1.7 secret");
      const miss = await getArtifact(fixture, await artifactOf("secret.pdf", "preview"));
      expect(miss.status).toBe(404);
      // A refusal is JSON, never the file: the route read the cache and found nothing there.
      expect(new TextDecoder().decode(miss.bytes)).not.toContain("secret");
    });
  });
});

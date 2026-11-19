/**
 * C6 (0239): the 150-page document's first preview, N times, through the machine's own office job.
 *
 * @remarks
 * **The number is the engine's**, not a browser's: \`OfficeResult.stats.ms\` is what the pack reports
 * for the conversion, and that same number is what the object's \`office.job\` audit line carries.
 * What this script adds is the repetition the criterion asks for, and each run is a **cold** cache
 * (its own directory), so none of them is a cache hit reported as a conversion.
 *
 * The job is \`runOfficeJob\` — the function the machine's \`op: "office"\` route calls — over the
 * machine's own cache, sandbox, and pack. The document is generated here (\`n150.ts\`). The host's
 * condition is printed with the numbers, because a millisecond figure without it says nothing.
 *
 * Usage: \`node --experimental-strip-types e2e/tools/c6.ts [runs]\`
 */
import { createHash } from "node:crypto";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { operationId } from "@hns/core";
import { OfficeCache, runOfficeJob } from "../../packages/machine/src/index.ts";
import { pagesDocument } from "./n150.ts";
import { ensurePack } from "../support/pack.ts";

const RUNS = Number(process.argv[2] ?? "10");
const PAGES = 150;

/** One timing: the job the machine ran, and what it says it took. */
interface Sample {
  readonly ms: number;
  readonly bytes: number;
  readonly pages: number;
}

/** The machine's own office bounds (\`OFFICE_LIMITS\`'s shape, as the wire carries them). */
const ENVELOPE = { timeoutMs: 60_000, maxRssMb: 4096 } as const;

async function main(): Promise<void> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "hns-c6-")));
  const docx = join(root, "計測.docx");
  await writeFile(docx, pagesDocument(PAGES));
  const version = "sha256:" + createHash("sha256").update(await readFile(docx)).digest("hex");
  const pack = await ensurePack({ root: join(import.meta.dirname, "..", ".."), build: false });
  const samples: Sample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    // A fresh cache and work directory per run: every read is a conversion, never a hit.
    const cacheRoot = join(root, "cache-" + String(run));
    const workRoot = join(root, "work-" + String(run));
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(workRoot, { recursive: true });
    const result = await runOfficeJob(
      {
        cache: new OfficeCache({ root: cacheRoot }),
        packRoot: realpathSync(pack.root),
        workRoot,
      },
      {
        v: 1,
        id: operationId("c6-" + String(run)),
        operation: "preview",
        input: { workspaceId: "w", path: basename(docx), version, format: "docx" },
        limits: {
          maxInputBytes: 50 * 1024 * 1024,
          maxCells: 400_000,
          maxPixels: 50_000_000,
          maxOutputBytes: 50 * 1024 * 1024,
          timeoutMs: ENVELOPE.timeoutMs,
        },
      },
      root,
      "w",
      ENVELOPE,
      new AbortController().signal,
    );
    if (!result.ok) throw new Error("the engine refused: " + result.error + ": " + result.message);
    samples.push({
      ms: result.stats.ms,
      bytes: result.artifact.bytes,
      pages: result.artifact.pages ?? 0,
    });
    process.stderr.write("run " + String(run + 1) + ": " + String(result.stats.ms) + " ms\n");
  }
  report(samples, pack.root);
}

/** The numbers the criterion names, and the host they were measured on. */
function report(samples: readonly Sample[], packRoot: string): void {
  const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const at = (fraction: number): number =>
    times[Math.min(times.length - 1, Math.floor(fraction * (times.length - 1)))] ?? 0;
  process.stdout.write(
    JSON.stringify(
      {
        criterion: "150 ページ docx の初回: 中央値 3 秒以内、p95 5 秒以内",
        runs: samples.length,
        pages: samples[0]?.pages ?? null,
        bytes: samples[0]?.bytes ?? null,
        ms: { median: at(0.5), p95: at(0.95), min: times[0] ?? 0, max: times.at(-1) ?? 0 },
        all: times,
        host: {
          cpu: cpus()[0]?.model ?? "unknown",
          cores: cpus().length,
          memoryGb: Math.round(totalmem() / 1024 ** 3),
          loadAverage: loadavg(),
          node: process.version,
          platform: process.platform + " " + process.arch,
        },
        pack: packRoot,
      },
      null,
      2,
    ) + "\n",
  );
}

await main();

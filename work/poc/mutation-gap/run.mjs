// T-03-lite: show that ExecutionEnv.writeFile accepts no expected version and that
// a shell write bypasses Durable's in-process file mutation queue.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";

const dir = await mkdtemp(join(tmpdir(), "hns-gap-"));
const env = new NodeExecutionEnv({ cwd: dir });
const file = "notes.md";

// 1. Lost update: both clients read v1, both write a full replacement.
await env.writeFile(file, "line-1\n", ctx);
const a = getOrThrow(await env.readTextFile(file, ctx));   // client A reads
const b = getOrThrow(await env.readTextFile(file, ctx));   // client B reads
await env.writeFile(file, a.replace("line-1", "line-1\nA"), ctx);
await env.writeFile(file, b.replace("line-1", "line-1\nB"), ctx); // B's base is stale; no error
console.log("lost update — final content:", JSON.stringify(getOrThrow(await env.readTextFile(file, ctx))));

// 2. Shell write bypasses coordination: a version check read before it cannot see it.
await env.writeFile(file, "keep\n", ctx);
const snapshot = getOrThrow(await env.readTextFile(file, ctx));
getOrThrow(await env.exec("printf 'shell-change\\n' > notes.md", undefined, ctx));
const stillOld = snapshot === getOrThrow(await env.readTextFile(file, ctx));
console.log("shell bypass — env read still equals pre-shell snapshot:", stillOld);
console.log("shell bypass — actual content:", JSON.stringify(getOrThrow(await env.readTextFile(file, ctx))));

// 3. Non-atomic in-place write: no rename, so a crash mid-write can leave a truncated file.
console.log("writeFile implementation:", "mkdir(parents) + fs.writeFile (in-place truncate/write); renameFile exists but is not used");

await env.cleanup(ctx);
await rm(dir, { recursive: true, force: true });

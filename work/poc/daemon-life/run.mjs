// What survives Connection.close()? The daemon, or the processes it started?
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), "hns-daemon-"));
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: dir, connection });
const info = await connection.info();
console.log("daemon pid:", info.pid);

getOrThrow(await env.exec("sh -c 'sleep 300 >/dev/null 2>&1 & echo $! > child.pid'", undefined, ctx));
const child = Number.parseInt((await readFile(join(dir, "child.pid"), "utf8")).trim(), 10);
console.log("child pid:", child, "| both alive:", alive(info.pid) && alive(child));

connection.close();
for (const ms of [2000, 10000, 35000]) {
  await sleep(ms === 2000 ? 2000 : ms === 10000 ? 8000 : 25000);
  console.log(`+${ms}ms daemon:`, alive(info.pid), "child:", alive(child));
}
if (alive(child)) process.kill(child, 9);
if (alive(info.pid)) process.kill(info.pid, 9);
await rm(dir, { recursive: true, force: true });

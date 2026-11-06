// Start the worker with the editor UI.  node serve.mjs [root]
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startServer } from "../walking-skeleton/server.mjs";

const dir = process.argv[2] ?? (await mkdtemp(join(tmpdir(), "hns-editor-")));
const base = await mkdtemp(join(tmpdir(), "hns-editor-base-"));
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: dir, connection });
const app = await startServer({ env, root: dir, journalPath: join(base, "journal.json"), webDir: import.meta.dirname });
console.log("root:", dir);
console.log("url: ", app.url);
process.on("SIGINT", async () => { await app.close(); await connection.close(); process.exit(0); });

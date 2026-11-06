// Start the integrated app.  node serve.mjs [root]
//   PROVIDER=faux|ollama|opencode   MODEL_ID=...   STATE_DIR=...
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";

const root = process.argv[2] ?? process.cwd();
const provider = process.env.PROVIDER ?? "ollama";
const stateDir = process.env.STATE_DIR ?? join(homedir(), ".local", "state", "hns");
await mkdir(stateDir, { recursive: true });

const app = await startApp({
  stateDir, root, provider,
  model: process.env.MODEL_ID,
  webDirs: [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")],
});
console.log("url:   " + app.url);
console.log("root:  " + root);
console.log("state: " + stateDir);
console.log("model: " + provider + " / " + (process.env.MODEL_ID ?? "(default)"));
process.on("SIGINT", async () => { await app.close(); process.exit(0); });

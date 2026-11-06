// OpenCode Go: pi-ai's provider, with the key read from our own file first.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

export const OPENCODE_KEY_PATHS = [
  join(homedir(), ".config", "hns", "opencode.key"),
  join(process.cwd(), ".work", "opencode.key"),
];

export function readOpenCodeKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY.trim();
  for (const path of OPENCODE_KEY_PATHS) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  return undefined;
}

export function opencodeGo({ apiKey = readOpenCodeKey(), model = "deepseek-v4.1-flash" } = {}) {
  process.env.OPENCODE_API_KEY = apiKey;
  return { provider: opencodeGoProvider(), model };
}

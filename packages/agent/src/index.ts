export { openAgent } from "./agent.ts";
export type { Agent, AgentModelRef, AgentOptions, Models, Turn } from "./agent.ts";
export type { AgentEvent, AgentEventSink } from "./events.ts";
export { failureOf } from "./failure.ts";
export type { ReadReply, ToolFailure, WriteReply } from "./failure.ts";
export { fileKeySource, fixedKeySource, readKey } from "./keys.ts";
export type { KeyLookup, KeySource } from "./keys.ts";
export {
  ollamaCloud,
  ollamaKeyLookup,
  readOllamaKey,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_PROVIDER,
} from "./providers/ollama.ts";
export type { BuiltModel, BuiltProvider, OllamaOptions } from "./providers/ollama.ts";
export {
  opencodeGo,
  opencodeKeyLookup,
  readOpenCodeKey,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_PROVIDER,
} from "./providers/opencode.ts";
export type { OpenCodeModel, OpenCodeOptions } from "./providers/opencode.ts";
export type { ShellAccess } from "./shell.ts";
export { operationIdFor, toolNames, workspaceTools } from "./tools.ts";
export type { WorkspaceToolsOptions } from "./tools.ts";

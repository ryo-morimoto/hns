# Changelog

## 0.1.0

- \`openAgent()\`: Harness, conversation, tools, and observation composed at one boundary.
- Workspace tools whose refusals are values (denied / conflict / unknown), not exceptions.
- `write_file` names its operation after the tool call, so the model cannot collapse two writes into one.
- `read_file` returns at most 64 KiB and reports the whole file's version; `openAgent` refuses a cwd outside the root.
- bash registered only when a sandbox is available.
- Ollama Cloud and OpenCode Go adapters, with key lookup from the environment and \`~/.config/hns\`.

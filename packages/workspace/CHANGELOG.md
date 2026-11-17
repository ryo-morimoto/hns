# Changelog

## Unreleased

- `checkpointRun` reports the pack's size (`packBytes`) and its largest blob (`maxBlobBytes`) beside the bytes, so
  a caller sending the pack and a mirror deciding whether Artifacts can take it measure once (0244).

## 0.1.0

- Workspace: versioned read/write, a journal, recovery, the audit trail, and the change log.
- Rooted helper: opens and renames from a directory fd, with the path-based fallback.
- Journal: atomic saves, a bounded set of settled operations (`maxSettledOps`), and one content per `operationId`.
- `contains()` for cwd containment, and `rooted: "required"` to refuse opening without the helper.
- Sandbox: bubblewrap detection, \`createSandboxEnv\`, and \`createNoExecEnv\`.
- `./objects`: git-compatible object ids and v2 packs over R2, with dedupe and checkpoint packs.

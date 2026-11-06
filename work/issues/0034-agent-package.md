# 0034: agent パッケージ（移植）

status: open
depends-on: 0033
touches: packages/agent

## Goal

Durable の組み立て・ツール・hooks・プロバイダを packages/agent に移す。

## Acceptance criteria

- [ ] Harness / conversation / resume を移す
- [ ] read_file / write_file / bash と観測 hooks を移す
- [ ] Ollama / OpenCode アダプタを移す
- [ ] faux の統合テストが通る

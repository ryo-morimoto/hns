# 0035: server パッケージ（移植）

status: open
depends-on: 0034, 0037
touches: packages/server

## Goal

PoC の HTTP/SSE/認証/周辺機能を packages/server に移し、bin で起動できるようにする。

## Acceptance criteria

- [ ] HTTP / SSE / 認証（token・tailnet・passkey・session）/ 秘密の API
- [ ] Workflow・Automation・バックアップ・利用量・観測
- [ ] bin `hns` で起動（--root / --state / --provider）
- [ ] API エラーは ErrorCode に統一
- [ ] 会話のトークンとツール実行を SSE で流す

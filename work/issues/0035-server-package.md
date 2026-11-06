# 0035: server パッケージ（移植）

status: open
depends-on: 0037, 0046, 0047, 0048, 0049, 0050
touches: packages/server, package.json, package-lock.json

## Goal

PoC の HTTP/SSE/認証/周辺機能を packages/server に移し、bin で起動できるようにする。

## Acceptance criteria

- [ ] HTTP / SSE / 認証（token・tailnet・passkey・session）/ 秘密の API
- [ ] Workflow・Automation・バックアップ・利用量・観測
- [ ] bin `hns` で起動（--root / --state / --provider）
- [ ] API エラーは ErrorCode に統一
- [ ] 会話のトークンとツール実行を SSE で流す

## 進め方

1. 骨組み: Fastify 5、設定の parse、bin、`/api/health`、エラーハンドラ
2. 認証と秘密（0048 の identity を使う）
3. files / conversations / chat / SSE（0049・0050 を使う）
4. projects / tasks / workflows / runs（逐次実行まで）
5. automations / usage / limits / events / metrics / backup

## Notes

- store の SQL は書かず、0047 / 0048 の API を使う。pi-durable も直接触らず、0049 の API を使う。
- 最初の縦切りは [engineering.md](../docs/engineering.md) の health / state / chat。
- テストは 0046 の規律に従う。
- `automations.last_fired_at` は store が full ISO を要求する。PoC の minute 文字列をそのまま渡さない。

## やらないこと

- Web UI（0036）。
- Workflow の並列・分岐・再試行・耐久（0038）。
- 観測の保持期間・外部送出（0039）。
- マルチマシン（0044）と配布（0040）。
- Playwright の E2E（0043）。

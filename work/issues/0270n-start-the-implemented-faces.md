# 0270n: 実装済みだが起動しない 5 面を起動する（Worker の send 面・deploy env・machine CLI）

status: open
priority: now
design: agreed
design-ref: 0226 / 0246 / 0224 / 0194 / 0225 の Result
depends-on: 0226
touches: packages/server/src/edge/, packages/server/src/graphql/, tools/deploy/, packages/machine/src/cli.ts

## Intent

0224 / 0225 / 0226 / 0246 / 0194 は main に入っているが、**実運用では誰も呼ばない**。各 Result が「実装した ≠ 起動する」として挙げた起動点は 3 つに集約できる。

1. **Worker の send 面**: 現状 session にメッセージを送る Worker の入口が無い（GraphQL にも send mutation が無い）。0226 の granted path は **send の body に policy snapshot** が要る。
2. **deploy の env**: `HNS_AGENT_URL` / `HNS_MACHINE_ID` / `HNS_CONTROL_PLANE_KEY` が揃うと 0226 の経路が開く。0225 の鍵取得（`/api/machines/keys`）と 0148 の registry も同じ env に依存する。
3. **machine の CLI**: `startMachineAgent` を起動するコマンドが無い（enrollment と起動）。0194 の sandbox も 0246 の mirror も 0225 の verifier も machine が起動して初めて動く。

## Acceptance

- [ ] machine を **人が 1 コマンドで起動**できる（enrollment の出力をそのまま渡せる）
- [ ] Worker の send 面（GraphQL か REST）が **policy snapshot を載せて** Session DO に転送する
- [ ] deploy の env 3 つが **dry-run の binding 一覧**で確認でき、**欠けていれば起動時に明示的に失敗**する（黙って Phase 0 に落ちない）
- [ ] 実経路: machine 起動 → session に send → granted path でツール実行 → 監査に grantId
- [ ] 各面の「起動した / していない」を README か docs に 1 表で

## 設計（lead が決めたこと）

- **send の面は GraphQL にする**（D059）: `Mutation.sendMessage(input: SendMessageInput!)`。`sendMessage` は `conversationId` と `text` を取り、**Worker が D1 の active policy を読んで snapshot を body に載せ**、Session DO の `POST /rpc/conversations/<id>/messages` に転送する。REST の新設はしない（既存の `/api/*` の面を増やさない）。
- **env は起動時に検める**: `HNS_AGENT_URL` / `HNS_MACHINE_ID` / `HNS_CONTROL_PLANE_KEY` の**揃い方で 3 つの状態**を明示する（全部ある = granted path / 全部無い = Phase 0 / **一部だけ = 起動時に fail**）。黙って Phase 0 に落ちない。
- **machine の CLI** は `hns-machine enroll`（公開鍵を出して人が貼る）と `hns-machine run`（agent を起動）の 2 コマンド。**enrollment の出力をそのまま `run` に渡せる**形。

## Log

- 2026-11-18: 0226 / 0246 / 0224 / 0194 / 0225 の Result で同じ形の「起動点が無い」が 5 回出たため、まとめて 1 本にした。設計（send 面を GraphQL にするか REST にするか）は next で決める。

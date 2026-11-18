# 0270n: 実装済みだが起動しない 5 面を起動する（Worker の send 面・deploy env・machine CLI）

status: in-progress
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

- [x] machine を **人が 1 コマンドで起動**できる（enrollment の出力をそのまま渡せる）
- [x] Worker の send 面（GraphQL か REST）が **policy snapshot を載せて** Session DO に転送する
- [x] deploy の env 3 つが **dry-run の binding 一覧**で確認でき、**欠けていれば起動時に明示的に失敗**する（黙って Phase 0 に落ちない）
- [x] 実経路: machine 起動 → session に send → granted path でツール実行 → 監査に grantId
- [x] 各面の「起動した / していない」を README か docs に 1 表で

## 設計（lead が決めたこと）

- **send の面は GraphQL にする**（D059）: `Mutation.sendMessage(input: SendMessageInput!)`。`sendMessage` は `conversationId` と `text` を取り、**Worker が D1 の active policy を読んで snapshot を body に載せ**、Session DO の `POST /rpc/conversations/<id>/messages` に転送する。REST の新設はしない（既存の `/api/*` の面を増やさない）。
- **env は起動時に検める**: `HNS_AGENT_URL` / `HNS_MACHINE_ID` / `HNS_CONTROL_PLANE_KEY` の**揃い方で 3 つの状態**を明示する（全部ある = granted path / 全部無い = Phase 0 / **一部だけ = 起動時に fail**）。黙って Phase 0 に落ちない。
- **machine の CLI** は `hns-machine enroll`（公開鍵を出して人が貼る）と `hns-machine run`（agent を起動）の 2 コマンド。**enrollment の出力をそのまま `run` に渡せる**形。

## Log

- 2026-11-18: 0226 / 0246 / 0224 / 0194 / 0225 の Result で同じ形の「起動点が無い」が 5 回出たため、まとめて 1 本にした。設計（send 面を GraphQL にするか REST にするか）は next で決める。

## Result

- verdict: **PASS**（reviewer-0270n。blocking 0 / 低 8 → 指摘 5 点を修正して再 PASS）
- HEAD: 7e3509f（main に ff 統合）。gate は exit 0（1513 tests / 1514、main で 73.1s）。
- 起動した 3 面:
  - **send（GraphQL）**: `Mutation.sendMessage` → 本番 port（D1 の会話行 + active policy の snapshot）→ **本物の Session#fetch** → `admitTurn` → `#grantPathFor` → 本番 route（**run token 検証**）→ 本番 relay → **実 machine**。実測で machine の答えが `allow`、`policy_audit` と `session_grants` に**同じ grant_id**。**token 無しの直 POST は 401**（`session_grants` 0 行・machine log 0 行）。index に無い会話は `NOT_FOUND`。
  - **env の 3 状態**: `tool-path-mode.ts` が唯一の判定。全部あり = granted / 全部無し = Phase 0 / **一部だけ = 起動時 503**（Session 7 通り + edge 2 経路、認証前）。文言は**足りない binding を名指しし値を出さない**。**development でも `HNS_MACHINE_ID` は必須**（既定値を置くと名指ししていない machine に繋ぐ）。
  - **machine の CLI**: `hns-machine enroll` → 出力をそのまま `hns-machine run` へ → **本物の `startMachineAgent`** → 本番 `createMachineTransport` で `/rpc` health 200（pid 一致）。device.json は 0700 / 0600、**秘密は stdout に出ない**、既存鍵は `--force` 無しで拒否。
- 実装中に実経路で見つけて直したもの: CLI が `GrantKeys` を `controlPlane` に渡して**全要求 500**（型では防げず、実経路テストで検出）。
- **残り**: 画面の composer は無い（**0105**）。
- 非 blocking（follow-up）: `requester` の冗長な別名 / `console.log` の慣行 / main の `tools/gate/test/stages.test.ts` の整形残骸（lane の oxfmt が main を拾ったもの。untracked 扱いで stash 済み）。

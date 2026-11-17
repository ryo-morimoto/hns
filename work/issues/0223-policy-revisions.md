# 0223: ポリシー改訂・提案・承認（review token・CAS）

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §6, §9
depends-on: 0220
touches: packages/store/src/migrations/0003-policy.ts, packages/store/src/migrations/index.ts, packages/store/src/schemas.ts, packages/store/src/parse.ts, packages/store/src/repositories/policy.ts, packages/store/src/repositories/policy.test.ts, packages/server/src/policy/, packages/server/src/policy/policy.test.ts

## Intent

ツール権限をコードに散らすと、モデルからも運用からも変更点が見えない。ポリシーを D1 の不変 revision と active ポインタにし、agent は提案だけ、人は review token を見て承認する。承認時の TOCTOU と自己承認を、principal 分離と CAS で閉じる。

## Goal

`policy_revisions` / `policy_active` / `policy_proposals` を D1 に足し、store の repository と server のサービスを作る。既定ポリシーの冪等作成、提案、review token、承認 CAS、差分分類、principal 検査を実装する。GraphQL と UI は 0228 / 0229。

## Acceptance criteria

- [x] migration 0003 で 3 テーブルを加算する（既存テーブルを変えない）
- [x] `ensurePolicy(workspaceId)` が active を冪等に作り、revision 1 の既定（read/write は root、bash は sandbox 時のみ、egress なし）を返す
- [x] `propose(actor, input)` が pending を作り、baseRevision / baseHash / candidateHash / reviewToken を保存する
- [x] `decide(actor, input)` が `actor.kind === "human"` を要求し、active revision と review token を再計算して一致を要求する。CAS で active を切り替える
- [x] 差分を `narrowing` / `expansion` / `mixed` / `equal` / `unsupported` に分類し、unsupported は承認不可
- [x] agent の tool token では `decide` を呼べない（principal の型で表現する）
- [x] 失敗は `approval_stale` / `policy_denied` / `unsupported` の閉じた union で返す
- [x] `npm test -w @hns/store` と `npm test -w @hns/server` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 新規 workspace → ensurePolicy → revision 1 が 1 つだけ | 高 | 契約 §6 |
| C2 | 2 回 ensurePolicy → 同じ revision（冪等） | 中 | 契約 §6 |
| C3 | agent が提案 → pending。active は変わらない | 高 | R3 |
| C4 | 人が承認 → active が candidate に切り替わり、revision が +1 | 高 | S11 |
| C5 | 承認前に base が進む → review token 不一致 → `approval_stale`、active は変わらない | 高 | TOCTOU |
| C6 | agent の principal で承認 → 拒否 | 高 | 自己承認 |
| C7 | read root を足す → expansion。削る → narrowing。両方 → mixed | 高 | S10 |
| C8 | glob / 未知 tool → unsupported で承認不可 | 高 | 契約 §6 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C6 | D1 fixture + CAS 競合 | integration | `packages/store/src/repositories/policy.test.ts` |
| T2 | C3–C6 | サービス + fake repo | unit | `packages/server/src/policy/policy.test.ts` |
| T3 | C7–C8 | 差分表 | unit | 同じ |
| T4 | C4–C6 | 実 D1 | integration | `packages/server/test/integration/` |

## Notes

- 承認は全件人。自動承認は Phase 1 では入れない（D091）。差分は人が読む材料で、判断の代替ではない。
- OpenShell の `ApproveDraftChunk` は bearer + config:write + workspace admin を要求し、sandbox principal の allowlist に入っていない（[研究](../../work/research/tool-call-fastpath-security.md) §3.6）。hns は principal の型で同じ分離を作る。
- OpenShell の review token は rule + 現行/候補 policy hash + credential fingerprint の SHA-256。hns は credential fingerprint を Phase 1 では空文字にする。
- D1 の CAS は `UPDATE policy_active SET ... WHERE workspace_id = ? AND revision = ?`。0 行なら 409。

## 未確定

- migration の番号は実装時に次の空きを使う（0003 が埋まっていれば 0004）。`MIGRATIONS` の末尾に足す。

- 承認の監査を D1 のイベントに書くか、0222 の DO 監査に書くか。承認は Worker で起きるので、D1 の `events` に `policy.approved` を足す案が有力。0222 の後に決める。
- workspace の作成時に既定ポリシーを作るか、最初の grant 要求時に作るか。冪等ならどちらでもよいが、初回の read で書き込みを起こさないなら前者。

## やらないこと

- GraphQL / UI（0228 / 0229）。
- grant の発行（0224）。
- global policy / accepted risks（必要なときに別 issue）。

## Log

- 2026-11-17: 作成（D091）。

## Result

- verdict: **PASS**（reviewer-0223。blocking 0。NB2/NB3 は統合前に修正 → 再レビュー PASS）
- HEAD: 80cbf72（main に ff 統合）。gate は exit 0（1138 tests / 1139、main で 76.1s）。
- 確認: migration 0007（issue の 0003 は古い表記。現行 0006 の次が 0007）で 3 テーブル + index、revision は**追記のみ**（書き換えるメソッドが無い）、`HumanPrincipal` は型で agent から構築不可 + **実行時検査**（消すとテストが落ちる）、`activate` は **INSERT を CAS の述語でガード**（実測: D1 の batch は 0 行更新で rollback しないため、CAS が負けたら**何も書かない**）、reviewToken の再計算、`unsupported` は提案と承認の両方で拒否。実 D1（workerd）で並行 ensure / 承認による hash 変化 / stale / agent 拒否 / glob。
- 実測で分かったこと: **D1 の batch は 0 行更新で rollback しない**。だから「batch に入れる」だけでは孤児 revision が残る。INSERT 自体を CAS 述語で条件付けする形が正しい（`WHERE EXISTS (… revision=? AND hash=?)`）。
- 修正した中 2 / 低 1: 承認の append と CAS の原子化、CAS 成功後は必ず成功を返す（`proposalStale`）で再試行の罠を塞ぐ、`FakeD1` を store の test support に移して**store → server の逆依存**を解消。
- 非 blocking（follow-up）: 実 D1 の `proposalStale` 分岐が未到達（unit のみ）/ `baseHash` は `active.hash` を渡すほうが読める / `stale` と `exists` のメッセージが同じ / `activate` の pre-check の TSDoc / TTL 既定の二重化（0224）/ `HumanPrincipal` の柵の書き方 / 監査（`policy.approved`）と 0222 の鎖を繋ぐ経路が未定（0228）。
- 未確認: レビュー担当が 1 回だけ 7 失敗の gate を見たが再現せず原因不明（以後 7 回連続 green）。CI で再発したらログを取る。

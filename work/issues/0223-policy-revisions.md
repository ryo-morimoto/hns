# 0223: ポリシー改訂・提案・承認（review token・CAS）

status: open
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

- [ ] migration 0003 で 3 テーブルを加算する（既存テーブルを変えない）
- [ ] `ensurePolicy(workspaceId)` が active を冪等に作り、revision 1 の既定（read/write は root、bash は sandbox 時のみ、egress なし）を返す
- [ ] `propose(actor, input)` が pending を作り、baseRevision / baseHash / candidateHash / reviewToken を保存する
- [ ] `decide(actor, input)` が `actor.kind === "human"` を要求し、active revision と review token を再計算して一致を要求する。CAS で active を切り替える
- [ ] 差分を `narrowing` / `expansion` / `mixed` / `equal` / `unsupported` に分類し、unsupported は承認不可
- [ ] agent の tool token では `decide` を呼べない（principal の型で表現する）
- [ ] 失敗は `approval_stale` / `policy_denied` / `unsupported` の閉じた union で返す
- [ ] `npm test -w @hns/store` と `npm test -w @hns/server` が通る

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
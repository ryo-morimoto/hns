# 0228: ポリシー承認の GraphQL 面（Query / Mutation）

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §10
depends-on: 0223, 0198
touches: packages/server/src/graphql/policy.ts, packages/server/src/graphql/schema.ts, packages/server/src/graphql/context.ts, packages/server/src/graphql/queries.ts, packages/server/src/graphql/resolvers.ts, packages/server/src/graphql/views.ts, packages/server/src/graphql/policy.test.ts, packages/server/test/integration/graphql-policy.test.ts, packages/web/schema.graphql

## Intent

0223 のサービスはあるが、人が触る面がない。Relay のアプリ契約に、ポリシーの改訂一覧・提案・承認を載せる。0198 の Mutation 骨格に、policy の mutation を足す。

## Goal

`PolicyRevision` / `PolicyProposal` / `PolicyDiffAtom` の型と、`policyRevisions` / `policyProposals` の Query、`proposePolicy` / `decidePolicy` の Mutation を足す。失敗は閉じた union で返し、agent の principal では承認できない。

## Acceptance criteria

- [x] `PolicyDocument` / `PolicyRevision` / `PolicyProposal` / `PolicyDiff` / `PolicyDiffAtom` を GraphQL の object として定義する（`CapabilityScope` / `HostPort` は Phase 1 では出さない）
- [x] `Query.policyRevisions(workspaceId, first)` と `Query.policyProposals(workspaceId, status)` が result union を返す
- [x] `Mutation.proposePolicy(input)` と `Mutation.decidePolicy(input)` が 0223 のサービスを呼ぶ
- [x] `decidePolicy` は human principal だけ。agent の tool token は `policy_denied`
- [x] 失敗は専用の `PolicyFailure` と閉じた `PolicyErrorCode`（`policy_denied` / `approval_stale` / `unsupported` / `not_found` / `invalid_request`）で返す。既存の `QueryFailure` を広げない
- [x] SDL を再生成し、web の codegen が通る
- [x] `npm test -w @hns/server` と `npm run codegen` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 既定 revision → policyRevisions → 1 件、active | 高 | 契約 §10 |
| C2 | agent → proposePolicy → pending。active は不変 | 高 | R3 |
| C3 | human → decidePolicy(approve) → active が切り替わる | 高 | S11 |
| C4 | 古い reviewToken → decidePolicy → `approval_stale` | 高 | TOCTOU |
| C5 | agent の principal → decidePolicy → `policy_denied` | 高 | 自己承認 |
| C6 | glob を含む提案 → `unsupported` | 高 | 契約 §6 |
| C7 | 未知の workspace → `not_found`（空リストにしない） | 中 | 契約 §7 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C6 | GraphQL 実行 + fake service | unit | `packages/server/src/graphql/policy.test.ts` |
| T2 | C1–C7 | 実 D1 / 実 HTTP | integration | `packages/server/test/integration/graphql-policy.test.ts` |
| T3 | C6–C7 | 失敗 union の分岐 | unit | 同上 |

## Notes

- 0198 が Mutation の骨格を持つ。この issue は `mutations/policy` を足すだけで、root の組み立てを再実装しない。
- JSON scalar は使わない。差分は `PolicyDiffAtom { atomKind, value }` の配列で返す（[capability.md](../../docs/capability.md) §10）。
- 認可は境界で行う。resolver は `context.actor` を見て、agent の tool token を拒否する。UI の状態を信じない。

## 未確定

- codegen は 0228 と 0229 の両方で走らせる。生成物は各 issue の document の隣（`routes/policy/__generated__/`）に閉じ、0228 は `packages/web/schema.graphql` だけを所有する。

- `workspaceId` の global ID 形式（0177）。既存の `Project` と同じ変換を使う。
- 0198 の Mutation の failure union の形に合わせる。0223 のサービスが返す union を GraphQL に写す。

## やらないこと

- UI（0229）。
- 監査の GraphQL 面。
- global policy / accepted risks。

## Log

- 2026-11-17: 作成（D091）。

## Result

- verdict: **PASS**（reviewer-0228。初回 BLOCKED 2（glob の規則の写し / root の語彙と off-by-one）→ 修正 → PASS）
- HEAD: db78b1f（main に ff 統合）。gate は exit 0（1215 tests / 1216、main で 61.7s。1 回目は test 段で落ち、再実行で green）。
- 確認: 0198 の `MutationModule` に `policyModule()` を 1 箇所で追加。Query `policyRevisions` / `policyProposals`、Mutation `proposePolicy` / `decidePolicy`。失敗は `PolicyFailure` の閉じた union（`QueryFailure` / `MutationFailure` は不変）。**glob は core の `GLOB_CHARACTERS` 1 箇所**（face は `normalizePath` の答えを使う。`a/{b,c}` / `a/[bc]` / NUL / `..` / 絶対は `unsupported`）。root は **1..1,024 inclusive・workspace 相対 POSIX**（`Project.workspaceRoot` と別語彙）、**`[]` = 変更なし**、**`equal` は提案可（`diff.kind = EQUAL`）**。resolver と service の **2 段**で human を検査。
- 実経路: 実 D1（workerd）で agent が propose → human が decide → active 1→2。HTTP 経路（createGraphQLFace → handler）も同じ。二重提案で stale、agent は `policy_denied` で何も書かない、glob は `unsupported` で 0 行。mutation P1〜P5。
- 非 blocking / follow-up: **agent が人の `hns_session` cookie を持つと区別できない**（0158 の `Session.kind` で閉じる。TSDoc と commit message に明記）/ 監査 `policy.approved` を 0222 の鎖に繋ぐ担当が未定 / **`equal` の承認は内容の変わらない revision を積む**（全件人承認なので許容、docs に 1 行必要）/ revision の global id が逆シリアル化不能 / `writable` が input に無い（Phase 2）/ `docs/capability.md` §10 に root の語彙の 1 段落が必要（所有者待ち）。

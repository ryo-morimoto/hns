# 0228: ポリシー承認の GraphQL 面（Query / Mutation）

status: open
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

- [ ] `PolicyDocument` / `PolicyRevision` / `PolicyProposal` / `PolicyDiff` / `PolicyDiffAtom` を GraphQL の object として定義する（`CapabilityScope` / `HostPort` は Phase 1 では出さない）
- [ ] `Query.policyRevisions(workspaceId, first)` と `Query.policyProposals(workspaceId, status)` が result union を返す
- [ ] `Mutation.proposePolicy(input)` と `Mutation.decidePolicy(input)` が 0223 のサービスを呼ぶ
- [ ] `decidePolicy` は human principal だけ。agent の tool token は `policy_denied`
- [ ] 失敗は専用の `PolicyFailure` と閉じた `PolicyErrorCode`（`policy_denied` / `approval_stale` / `unsupported` / `not_found` / `invalid_request`）で返す。既存の `QueryFailure` を広げない
- [ ] SDL を再生成し、web の codegen が通る
- [ ] `npm test -w @hns/server` と `npm run codegen` が通る

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
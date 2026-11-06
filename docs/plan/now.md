# now — 現在地と次の一手

- 更新日: 2026-11-06
- 現在のマイルストーン: **M1（ExecutionEnv の実証）**
- ゲート: Go with Conditions（要件v0.3 の継続。設計・限定PoCは可、本番実装は不可）

## いまの焦点

**「ExecutionEnv の上に Workspace の安全契約を載せられるか」** を、設計と最小の実測で確かめる。
Agent の会話・モデル接続・UI は、この境界が固まるまで作らない。

## 完了（2026-11-06）

| やったこと | 証跡 |
| --- | --- |
| 提供資料5点をリポジトリへ取り込み | `docs/sources/`, `docs/requirements/` |
| Pi Durable / pi-env の版を特定（1.5.0, tag `f9a2636`） | [調査01](../research/01-pi-durable-1.5.0-executionenv.md) |
| ExecutionEnv の実API確認（条件付き書き込みが無いこと） | 同上 §3 |
| **T-01 実行**: 適合テスト 29/29（LocalExecutionEnv） | [poc/env-conformance](../../poc/env-conformance/) |
| 失更新・シェル迂回の再現 | [poc/mutation-gap](../../poc/mutation-gap/) |
| Workspace Execution Contract v0.1 | [設計](../design/workspace-execution-contract-v0.1.md) |
| ADR-0001（1.5.0固定・境界） | [決定](../decisions/0001-pin-pi-durable-1.5.0.md) |

## 次にやること（順序）

1. **T-02: Root 封じ込めの PoC**
   `..`、絶対パス、symlink 脱出、Root 置換を試し、拒否と監査が成立するかを見る。
   合格条件は契約 §6・§10。
2. **T-03/T-04: Mutation の故障注入**
   2クライアントの同時編集（conflict）と、intent 後・rename 前・outcome 前の停止（unknown 照合）。
3. **Workspace 層の Walking Skeleton**
   `WorkspaceFileApi` の read / write / watch を、最小の Worker 上で端から端まで通す。

## 決めてほしいこと（ユーザー）

| # | 論点 | こちらの案 |
| --- | --- | --- |
| D-1 | ADR-0001（1.5.0固定・条件付き書き込みは自前）を採用してよいか | 採用 |
| D-2 | 要件#2 の解釈: 「各マシンで Core Agent」か「中央Harness + 遠隔Tool」か | まず後者で PoC し、前者を比較材料に残す |
| D-3 | 最初の実用範囲（MVP）: Conversation + 1マシンのファイル編集か、2マシン接続までか | 1マシンで「会話→編集→差分→再開」を通す |
| D-4 | プロダクト名・リポジトリ名（`hns` の意味） | 未定のまま進められる |

## 未決事項

要件v0.3 §9（U-01〜U-13）に、次の2つを追加した。

- **U-14**: 開発環境の固定（このマシンは `node` が PATH に無く、nix store から起動している）。
- **U-15**: Workspace Journal の保存先（Durable Storage と同居か、別DBか）。
- **U-16**: 文書検査・タスク管理の道具（fps-hns の `npm run check` / backlog CLI を流用するか）。

## 止めていること

- 本番向けの Worker 認可・Shell 隔離が未完成の状態で、危険な Tool を公開すること。
- 外部副作用の Exactly-once を前提にした設計。
- 上流 Durable の内部実装（Storage・クラス）への直接結合。

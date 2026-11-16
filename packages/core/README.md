# @hns/core

hns のモデル。モデルの正本は `src/types.ts`。GraphQL の SDL はここから起こす。
耐久の契約語彙は `src/durability.ts` に置き、GraphQL には載せない。

```bash
npm run typecheck
npm run build
```

## 中身

- `src/types.ts` — Project / Conversation / Task / Workflow / Automation / Event / Metrics などのモデルと語彙。
- `src/codecs.ts` — IsoTimestamp / OperationId の brand・schema・constructor。規則の owner はここ1箇所。
- `src/durability.ts` — 耐久の契約語彙（`FAILURE_CLASSES` / `DURABILITY_AUTHORITIES`）と `CheckpointRef` / `DurableUnit`。
- `src/lease.ts` — 書き込みの lease（`WorkspaceLease`）と拒否の語彙（`LEASE_REFUSALS`）。
- `src/workflow.ts` — Workflow / Automation の状態遷移と `validateWorkflowGraph()`。
- `src/result.ts` — `Result<T, E>`。想定内の失敗を値で返す。
- `src/graphql/` — `types.ts` から SDL を起こす射影。`@hns/core/graphql` として公開し、ルート entry には出さない。

要求・応答の封筒は core に置かない。REST の面は、それを実装するパッケージが schema・認証・handler を
同じ変更で足す（D059）。core にあるのは、永続するモデルと、2つ以上のパッケージが使う型だけ。

## 型の置き場所

- Project / Conversation / Task / Workflow / Automation / Firing / Event / Usage — `store` が作る。
- WorkflowRun / WorkflowRunNode — `store` / Session DO が作る。
- FileRead / MutationResult — `workspace` が返す。
- CheckpointRef / DurableUnit / FailureClass / DurabilityAuthority — 耐久の契約。0153〜0155 が消費する（現時点の product call site は無い）。
- WorkspaceLease / LeaseRefusal — 書き込みの lease の契約。0156 / 0157 が消費する（現時点の product call site は無い）。
- Limits — 運用の面が読む。

Row 型（`archived: 0 | 1` など）は `store`、実行中の内部状態は `agent`、ファイル操作の内部型は `workspace`。
詳細は [docs/packages.md](../../docs/packages.md) を見る。

## codec

- `IsoTimestamp` は ISO 8601 の文字列だけを型にし、store の clock と timestamp 入力に使う。
  `IsoTimestampSchema` / `isoTimestamp()` 以外で作らない。
- `OperationId` は `[A-Za-z0-9_-]{1,64}` だけを型にし、workspace.write の入口でも parse する。
- package 間で codec を再定義していないことは `test/codecs.test.ts` が確認する。

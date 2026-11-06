# hns: Architecture

## Goals

- 1つのセルフホスト UI から、複数マシンの Agent を操作する。
- 借りる: Agent Runtime（Pi Durable）、遠隔実行（pi-env）、Model 接続（pi-ai）。
- 作る: Control Plane、Workspace、Project/Task/Workflow、Web UX。

## 所有境界

| 状態 | 正本 | 所有 |
| --- | --- | --- |
| Conversation / Agent Task / Tool 呼び出し | Pi Durable | Agent Runtime |
| ファイルの実体 | 各マシンの FS | OS |
| 版 / Mutation / イベント / 認可 | Workspace Journal | Workspace |
| Project / Task / Workflow / Run / Machine | Control Plane DB | Application |
| 未保存の編集 | クライアント | Editor Buffer |
| Git の状態 | Git | Git |

Agent の Checkpoint とファイル変更は同一トランザクションではない（INV-05）。

## 構成

```text
Web UI（Conversation / Progress first）
  └─ Control Plane: Auth, Machine Registry, Run, Project/Task/Workflow, Progress投影
       ├─ Pi Durable Adapter ── Pi Durable 1.5.0
       │        └─ ExecutionEnv
       └─ Workspace（版・Journal・認可・イベント）
                └─ ExecutionEnv = FileSystem + Shell
                     ├─ NodeExecutionEnv（同一マシン）
                     └─ RemoteExecutionEnv（SSH + pi-env daemon）

常駐 Machine Agent は ExecutionEnv の別実装として後から差し替える（[D004](docs/decisions.md)）。
```

## 主要フロー

1. **Run**: UI → Control Plane が Workspace / Execution Target を解決 → Durable に submit → Tool は ExecutionEnv 経由 → イベントを Progress に投影。
2. **Write**: read で版取得 → `expectedVersion` を確認 → 同一ディレクトリの temp に書いて rename → Journal → イベント（[workspace.md](docs/workspace.md)）。
3. **Failure**: Worker 切断・結果不明は `UNKNOWN` として保持し、再接続後に照合する。自動フェイルオーバーはしない。

## 不変条件

| ID | 条件 |
| --- | --- |
| INV-01 | Agent Run は認可済み Workspace と Execution Target に紐づく |
| INV-02 | Worker は Mutation 時に Root と権限を検証する |
| INV-03 | 版付き書き込みは古い内容を黙って上書きしない |
| INV-04 | 再送は既存結果を返すか照合する。盲目的に再適用しない |
| INV-05 | Checkpoint と外部 Mutation は別トランザクション |
| INV-06 | Progress は永続化済みの事実から復元できる |
| INV-07 | Editor の dirty Buffer は外部変更で黙って上書きされない |
| INV-08 | User Task と Durable 内部 Task は別 ID・別ライフサイクル |

## Phases

| # | 範囲 | 出口 |
| --- | --- | --- |
| M0 | 設計ベースライン | 境界と未決が説明できる（完了） |
| M1 | ExecutionEnv の実証 | T-01 合格、契約 v0.1（完了） |
| M2 | Mutation・会話・Editor | 完了（diff は 0009） |
| M3 | 2マシン・復旧・投影 | T-05/T-06/T-07 |
| M4 | 最初の実用版 | 会話→編集→差分→再開 |

## Open questions

| ID | 論点 | リスク | 決める条件 |
| --- | --- | --- | --- |
| U-01 | 中央 Harness か各マシン Core Agent か | 高 | [比較](docs/topology.md) → BOARD D-2 |
| U-03 | Worker 認証・Shell 隔離 | 高 | Remote Tool 公開前の脅威モデル |
| U-04 | Mutation の原子性・冪等性 | 高 | T-03/T-04 |
| U-05 | Provider / OAuth の正式方式 | 中 | Ollama Cloud で1つ確認済み。正式 API は鍵待ち |
| U-06 | `commandgode` の実体 | 中 | 名称保留 |
| U-07 | UI / Editor ライブラリ | 低 | Buffer PoC |
| U-08 | Editor Buffer の永続化 | 中 | 再起動・切断試験 |
| U-09 | Workflow のグラフ形式 | 中 | Workflow 実装開始前 |
| U-10 | Git Diff の範囲 | 低 | Git PoC |
| U-11 | Grabber のデータと権限 | 中 | Extension PoC |
| U-12 | チーム利用と RBAC | 中 | 外部共有前 |
| U-13 | Progress イベント schema | 中 | Watch 適合試験 |

U-02（Pi Durable API）は 1.5.0 の実測で解消（[work/research/pi-durable-1.5.0.md](work/research/pi-durable-1.5.0.md)）。

## 実測

適合テスト・失更新・Root 封じ込めは [work/poc/](work/poc/) と [work/research/pi-durable-1.5.0.md](work/research/pi-durable-1.5.0.md)。
# 用語

- 更新日: 2026-11-06

要件v0.3 §2 の用語を、実装で使う名前と対応づける。ここに無い語を新しく作らない。

| 用語 | 意味 | 実装上の名前（予定） |
| --- | --- | --- |
| Project | ユーザーの作業・管理単位。Workspace・Task・Conversation・Workflowを持つ | `Project` |
| Workspace | ファイルRoot・実行先・操作ポリシーを束ねる論理的なアクセス境界 | `Workspace` |
| Workspace Root | Machine上の許可済みディレクトリ/Worktree | `Root` |
| Machine / Worker | ホストと、そこへの接続主体 | `Worker` |
| Execution Target | Toolが実際に動く対象 | `ExecutionTarget` |
| Conversation | Pi Durable 側の対話・実行履歴の境界 | そのまま |
| Agent Run | Applicationが識別する実行単位 | `Run` |
| User Task | プロジェクト側の仕事。Durable内部Taskとは別 | `Task` |
| Workflow Definition / Run | グラフ定義と、その版の実行 | `Workflow` |
| File Snapshot / Version | 読み取り結果と改訂識別子 | `Version`（`sha256:<hex>`） |
| Editor Buffer | 未保存の編集内容。実ファイルとは別の正本 | `EditorBuffer` |
| Progress Projection | UI用の投影。実行の正本ではない | `Progress` |
| Operation | 1回のMutation要求。再送の照合キー | `operationId` |
| UNKNOWN | 適用されたか判定できない結果 | `MutationResult.status = "unknown"` |
| Journal | WorkspaceのMutation intent/outcomeの永続記録 | `WorkspaceJournal` |

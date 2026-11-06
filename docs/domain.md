# ドメイン: Project / Task / Workflow

2026-11-06 / 設計（実装前）。正本は Control Plane の SQLite。Durable の会話・タスクとは別（INV-08）。

## エンティティ

| もの | 主な属性 | 関係 |
| --- | --- | --- |
| Project | id, name, createdAt | Workspace・Conversation・Task・Workflow を持つ |
| Workspace | id, machineId, rootPath | Project に属する |
| Conversation | Durable の id, projectId, title | Project に属する。1 Project に複数 |
| Task | id, projectId, title, status, createdAt, updatedAt | Project に属し、Run を持つ |
| Run | id, taskId?, conversationId?, workspaceId, status | 実行の記録 |
| Workflow | id, projectId, version, graph | Project に属する |
| WorkflowRun | id, workflowId, version, status, startedAt | 版を固定して実行する |

## 状態

- Task: `todo → doing → done`、任意で `blocked`（戻せる）
- WorkflowRun: `queued → running → done | failed | cancelled`
- Run: Durable の実行状態を投影する。正本にしない（INV-06）

## 決めたこと

- Task と Durable の内部 Task は別 ID・別ライフサイクル。
- Workflow は「定義（版）」と「実行」を分ける。実行は版を固定する。
- Conversation は Task に必須ではない（雑談・調査もある）。

## 未決

| ID | 論点 | 案 | 決める時 |
| --- | --- | --- | --- |
| D-01 | Task と Conversation の対応 | 1 Task に複数 Conversation | Task 実装時 |
| D-02 | Workflow の実行主体 | Durable の task に載せる | Workflow 実装前 |
| D-03 | Run の粒度 | 1 送信 = 1 Run | 実装時 |
| D-04 | 削除と履歴 | 論理削除 + 監査 | Task 実装時 |

## 実装順

1. Project と Task の CRUD（API + SQLite）
2. Conversation を Project に紐付け、一覧できるようにする
3. Workflow（定義 → 実行）は最後。エッジの形が決まってから

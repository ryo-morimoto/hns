# @hns/core

hns のモデル。`src/types.ts` が唯一の正本。

```bash
npm run typecheck
npm run build           # dist/ に型
```

- `src/types.ts` — Project / Task / Conversation / Event / Metrics などの型（正本）。
- `src/schemas.ts` — 境界の valibot schema。`v.GenericSchema<unknown, T>` で型に縛る。
- `src/codecs.ts` — IsoTimestamp / OperationId の brand・schema・constructor。規則の owner はここ1箇所。
- `src/workflow.ts` — Workflow / Automation の状態遷移表。

## 型と持ち主

| 型                                                 | 作る場所                                   | 使う場所                 |
| -------------------------------------------------- | ------------------------------------------ | ------------------------ |
| `Project`                                          | `GET/POST /api/projects`                   | Project 一覧             |
| `Conversation`                                     | `GET/POST/PATCH/DELETE /api/conversations` | 会話一覧・ヘッダー       |
| `Message` `TaskView` `State`                       | `GET /api/state`                           | 会話画面・進捗           |
| `ChatRequest` / `ChatResponse`                     | クライアント / `POST /api/chat`            | 会話画面                 |
| `Task` / `TaskCreate` / `TaskUpdate`               | `/api/tasks`                               | Task 一覧                |
| `FileRead` / `FileWriteRequest` / `MutationResult` | `/api/file`                                | エディタ                 |
| `Event`                                            | `/api/events`                              | 観測・テスト             |
| `Metrics` / `Usage`                                | `/api/metrics` / `api/usage`               | ダッシュボード           |
| `Health` / `Limits` / `SandboxStatus`              | `/api/health`                              | ログイン・設定           |
| `ErrorResponse`                                    | 全エンドポイント                           | クライアントのエラー処理 |

`types.ts` の各型の JSDoc にも「Produced by / Consumed by」を書いてある。

## codec

- `IsoTimestamp` は ISO 8601 の文字列だけを型にし、store の clock と timestamp 入力に使う。
  `IsoTimestampSchema` / `isoTimestamp()` 以外で作らない。
- `OperationId` は `[A-Za-z0-9_-]{1,64}` だけを型にし、workspace.write の入口でも parse する。
- package 間で codec を再定義していないことは `test/codecs.test.ts` が確認する。

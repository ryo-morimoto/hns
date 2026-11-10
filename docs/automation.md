# Automations: スケジュール / Webhook

2026-11-06 / **実装済み（0018）**。要件12。Workflow（0017）の上に置く。

## 何を自動化するか

- **きっかけ**: 時刻（cron）／Webhook（HTTP）
- **やること**: Workflow を開始、会話にメッセージを送る、Task を作る
- **記録**: いつ・何が起動し・どう終わったか（成否・所要・出力）

## エンティティ

| もの       | 属性                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| Automation | id, projectId, name, trigger, action, enabled, createdAt                       |
| Trigger    | schedule（cron / timeZone）または webhook（token）                             |
| Action     | workflow（workflowId / input）・chat（conversationId / prompt）・task（title） |
| Firing     | id, automationId, at, status（queued/running/done/failed）, detail, runId      |

## 決めたこと

- 実行は既存の Workflow Run に委譲する。Automation は実行状態を持たず、Firing だけ残す。
- Webhook は `POST /api/hooks/<token>`。token は Automation ごとに発行し、本文を input として渡す。
- 同時実行は Automation ごとに 1 つ。実行中に来たものは 1 件だけキューし、それ以外は落とす。
- 落ちた実行は再試行しない。Firing に理由を残す。時刻の取りこぼしは遡らない（最新のみ）。
- 停止は `enabled = false`。実行中のものは止めない（次の機会から止まる）。
- cron は 5 フィールド、**サーバのローカル時刻**。DOM と DOW を両方指定したときは OR（標準 cron）。
- 同じ分に二度は発火しない（`last_fired_at`）。Webhook は 202 を返し、実行は非同期。
- テストは時計を注入する（製品にデバッグ用の口は置かない）。

## 未決

| ID   | 論点               | 案                                         | 決める時       |
| ---- | ------------------ | ------------------------------------------ | -------------- |
| A-01 | cron の実装        | 自前の 5 フィールド + TZ、またはライブラリ | 実装時         |
| A-02 | 認証               | localhost 前提。token は URL に含める      | 外部公開前     |
| A-03 | Webhook の入力検証 | JSON サイズ上限と schema                   | 実装時         |
| A-04 | 失敗の通知         | まず Firing に残すだけ                     | 必要になったら |

## 実装順

1. Automation と Firing の保存、Webhook 起点で Workflow を開始
2. スケジュール（分単位のタイマー、cron）
3. 会話・Task の action、停止・再開、履歴の表示

# hns: Architecture

## Goals

- 1つの UI から、複数のマシンで動く Agent を操作する。
- **UI とサーバのコードは自分で動かせる。データの正本は Cloudflare のアカウントに置き、実行は自分のマシンに残す**（[D047](docs/decisions.md)）。
- 借りる: Agent Runtime（Pi Durable 1.5.0）、Model 接続（pi-ai）、保存（Durable Objects / R2 / D1）、経路（cloudflared）。
- 作る: Machine Agent、Workspace の耐久、Control Plane、Project/Task/Workflow、Web UX。

「セルフホスト」は UI とサーバのコードを指す。Cloudflare アカウント無しでは会話は動かない。

## 所有境界

| 状態 | 正本 | 所有 |
| --- | --- | --- |
| Conversation / Agent Task / Tool 呼び出し | Session DO（PiHarness） | Agent Runtime |
| Run の実行中状態 | Session DO（PiHarness） | Application |
| 確定したファイル内容 | **`(C, J)`**: R2 の checkpoint commit + Workspace DO の Journal | Workspace |
| 版 / Mutation / lease / 認可 | Workspace DO | Workspace |
| ファイルの実体（作業ツリー） | `C ⊕ J ⊕ U` の写像。**失ってよい** | OS |
| Project / Task / Workflow 定義 / Machine | **D1** | Application |
| 一覧・検索 | D1（索引。作り直せる） | Application |
| 未保存の編集 | クライアント | Editor Buffer |
| Git の状態 | Git（`refs/hns` の checkpoint は R2） | Git |

`U` はまだどこにも確定していない変更で、durable ではない（INV-05）。契約は [durability.md](docs/durability.md)。

要件2（複数マシンで Agent を動かす）は、同じ workspace を2台から同時に編集できることを意味しない。書き込みの権利は lease で 1 台に閉じ、読み取りは lease を要さない（INV-13 / [durability.md](docs/durability.md) §3.4）。

## 構成

```text
Browser ── HTTPS / WS ─▶ Worker（edge: 認証・ルーティング・相関 ID）
                          ├─▶ Session DO（PiHarness）── pi-durable 1.5.0（1 ワークスペースに 1 つ）
                          │        └─ RPC ─▶ Workspace DO（(C,J)・版・lease・認可）
                          │                     └─ R2: checkpoint commit（git object）
                          ├─▶ Provider gateway（鍵・上限）── pi-ai ── Model
                          └─▶ D1: 定義・台帳・索引（正本。実行中の状態は置かない）

Workspace DO ── 署名付き HTTPS ──▶ cloudflared ──▶ Machine Agent
                                                      └─ ExecutionEnv = FileSystem + Shell（bwrap）
```

Web のアプリ契約は **GraphQL（`/graphql` 1 endpoint）**、クライアントは Relay（[D055](docs/decisions.md)）。
passkey・hooks・health / metrics / usage・machine agent・ファイルのバイト列は REST のまま残す（graph の形をしていない面）。

### 保存先の割り当て

| 用途 | 何を使うか | 理由 |
| --- | --- | --- |
| 会話・run の調整 | **DO**（Session、1 ワークスペースに 1 つ） | エンティティ単位の調整が中心（[D049](docs/decisions.md)） |
| Journal / 版 / lease | **DO**（Workspace） | 高頻度の小さい書き込みと epoch の整合 |
| 定義・台帳・索引 | **D1** | レコードを SQL で引く |
| ワークスペースの内容 | **R2** | object key で置く |
| 定期起動 | **Cron Triggers** | DO の alarm は実行中 run の wake にだけ使う |
| 重い後処理 | **Queues**（必要になってから） | ack の外に逃がす |

**DO は 2 クラスだけ。** DO を「全部の状態の置き場」にしない。実行中の状態は DO、確定したレコードは D1。

- Cloudflare は**ワークロードを実行しない**。git / npm / build / test はマシンで動く（Containers は採らない）。Worker / DO が担うのは制御と状態だけ。
- マシンは外向き接続だけで届く（cloudflared）。inbound ポートを開けない。SSH 経路は無い——理由は**マシンが NAT / tailnet の内側で inbound を受けない**こと（[D053](docs/decisions.md)）。
- マシン側は [topology.md](docs/topology.md) の A'' に当たる。

## 主要フロー

1. **Run**: UI → Worker → Session DO が submit → Tool は Workspace DO で版と lease を確認 → Machine Agent → ExecutionEnv → イベントは Session DO、確定したレコードは D1。
2. **Write**: read で版取得 → Workspace DO に intent → マシンで dirfd 解決・再ハッシュ・同一ディレクトリ temp + rename → outcome → ack（[workspace.md](docs/workspace.md)）。本文は 256KB まで DO、それ以上は R2 → DO の順。
3. **Checkpoint**: Run の終了で作業ツリーを commit にし `refs/hns/checkpoints/<runId>` を進める → R2 に pack を送る → watermark を書く → J を切り詰める。
4. **Restore**: C を展開 → J を seq 順に再生 → 未確定 intent を `unknown` として照合（INV-04）。
5. **Failure**: 切断・結果不明は `UNKNOWN` として保持し、再接続後に照合する。自動フェイルオーバーはしない。

## 不変条件

| ID | 条件 |
| --- | --- |
| INV-01 | Agent Run は認可済み Workspace と Execution Target に紐づく |
| INV-02 | Machine Agent は Mutation 時に Root と権限を検証する |
| INV-03 | 版付き書き込みは古い内容を黙って上書きしない（Workspace DO の直列化と、マシンの再ハッシュの二段） |
| INV-04 | 再送は既存結果を返すか照合する。盲目的に再適用しない（intent が先、outcome が後） |
| INV-05 | Checkpoint と外部 Mutation は別トランザクション。**U は Run 境界で commit 化されるまで durable でない** |
| INV-06 | Progress は永続化済みの事実（J とイベント）から復元できる |
| INV-07 | Editor の dirty Buffer は外部変更で黙って上書きされない |
| INV-08 | User Task と Durable 内部 Task は別 ID・別ライフサイクル |
| INV-09 | 正本は `(C, J)`。作業ツリーは写像であり、失ってよい |
| INV-10 | ack は単一システムで閉じる（DO の 1 トランザクション、または R2 → DO の順） |
| INV-11 | 実行中の状態は DO、確定したレコードは D1。どちらも他方の複製を正本にしない |
| INV-12 | migration は新規テーブルと nullable / 既定値付きの新列のみ（加算）。古い build は新しい DB を開かない（fail closed） |
| INV-13 | 書き込みの権利は lease で 1 台に閉じる。未取得・期限切れ・古い epoch は fail closed |

## Phases

| # | 範囲 | 出口 |
| --- | --- | --- |
| M0 | 設計ベースライン | 境界と未決が説明できる（完了） |
| M1 | ExecutionEnv の実証 | T-01 合格、契約 v0.1（完了） |
| M2 | Mutation・会話・Editor | 完了（diff は 0009） |
| M2.5 | 統合 MVP（1マシン） | 完了（0014・0015、E2E 12/12） |
| M3 | Project / Task / Workflow / Automation | 完了（0016〜0018） |
| M4 | 2マシン | A'' で可能になる（0148 で 2 台目を通す）。下げた T-05 を戻す |
| M5 | UI / UX の作り込み | D043 で画面単位に前倒し |
| M6 | Cloudflare 正本（D047・D048・D049） | 契約（0140–0142）と骨格（0145 / 0146 / 0156）が通り、実デプロイで 1 Run が 1 秒未満の上乗せに収まる |

## Open questions

| ID | 論点 | リスク | 決める条件 |
| --- | --- | --- | --- |
| ~~U-01~~ | 中央 Harness か各マシン Core Agent か | — | **解消**: A''（D047） |
| U-03 | Machine Agent の認証・Shell 隔離 | 高 | 0147 / 0165 |
| ~~U-04~~ | Mutation の原子性・冪等性 | — | **解消**: T-03/T-04。リモート経路は 0167 で再検証 |
| U-05 | Provider / OAuth の正式方式 | 低 | 0128。Ollama + OpenCode Go の2つ確認済み |
| U-06 | `commandgode` の実体 | 中 | 名称保留 |
| U-07 | UI / Editor ライブラリ | 低 | 0160 |
| U-08 | Editor Buffer の永続化 | 中 | 再起動・切断試験 |
| U-09 | Workflow のグラフ形式 | 中 | 0161 の着手前 |
| U-10 | Git Diff の範囲 | 低 | Git PoC |
| U-11 | Grabber のデータと権限 | 中 | 0165（XSS が exec に届く構成になった） |
| U-12 | チーム利用と RBAC | 中 | 外部共有前 |
| U-13 | Progress イベント schema | 中 | 0159 |
| U-22 | Automation の cron と同時実行 | 低 | 0161（Cron Triggers は最短1分） |
| U-23 | Cloudflare アカウント・ゾーンの前提 | 中 | 0144 / 0160 |
| U-24 | DO のロケーションとデータ所在地 | 中 | 0146 |

U-02（Pi Durable API）は 1.5.0 の実測で解消（[work/research/pi-durable-1.5.0.md](work/research/pi-durable-1.5.0.md)）。
U-25（checkpoint の契機）は Run 終了時に決定（D048）。

## 実測

- 適合・失更新・Root 封じ込め: [work/poc/](work/poc/) と [pi-durable 1.5.0](work/research/pi-durable-1.5.0.md)
- Cloudflare 構成: [work/poc/cf-harness](work/poc/cf-harness/README.md)。実デプロイで 1 op 28ms（p95 61ms）、1 ターン 4 op で 181ms（[RESULTS](work/poc/cf-harness/RESULTS.md)）

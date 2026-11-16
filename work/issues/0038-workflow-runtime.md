# 0038: Workflow / Automation の実行基盤

> 前提変更: 実行基盤は Session DO（0146）。alarm と wake の上で動かす。

status: open
priority: next
design: agreed
design-ref: D086
depends-on: 0145, 0146, 0156, 0157
touches: packages/server/src/do/, packages/server/src/graphql/, packages/server/test/, packages/store/src/, packages/core/src/workflow.ts

## Goal

Workflow / Automation を製品品質の実行基盤にする。

## Acceptance criteria

- [ ] 状態遷移は core/workflow.ts の表だけを通す
- [ ] 並列・分岐・再試行・人間待ち・中断からの再開
- [ ] 同時 1 実行、スキップ、再試行（trigger の schedule / webhook は 0161）
- [ ] 同じ firing / run を二重に実行しない
## 整理メモ（0161 との境界、2026-11-17）

- 0161 が automations の**起動**（Cron Triggers、マシンが寝ているときの park、Cloudflare Workflows の評価）を持つ。0038 は **run の実行**（状態遷移・並列 / 分岐 / 再試行 / 人間待ち / 中断からの再開）を持つ。
- 0038 の AC の「schedule / webhook」は 0161 と重なる。0038 は「起動された後の run」に絞り、trigger は 0161 に寄せる。
- 二重実行の防止は分担する: 0161 が firing の at-least-once、0038 が run の idempotency（firing / run の key で dedupe）。
- 依存は 0145 / 0146 だけでは足りない可能性: 0156（ファイルを使う node）、0152（admit + stream）を設計時に確認する。
- 0159（WS）は done。run の進捗は既存の live 面に載せる。

## Log

- 2026-11-17: D086 で合意。U-01〜U-05 を決定し、`design: agreed` にした。
## Design（D086 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D086）。

### 前提

- 定義（Workflow と graph・version）は D1 が正本（D049）。run の実行は Session DO（0146）の alarm / wake の上。ノード種別は agent / tool / human（core/types）。
- 0145: DO から D1 の制御データを触らない。0149 / D078: DO が正本で、D1 は索引（outbox で書く）。
- 0145 の索引例外を workflow run にも広げる（`@hns/store/workflow-index` の狭い writer だけを DO に許可）。
- 0159（WS）は done。0161 が trigger（Cron / webhook）。0157 が tool の write。0017 は PoC の逐次実行。

### 決定 1: run の正本は Session DO、D1 は索引

- 実行状態（run / node / attempt）は Session DO の SQLite に置く。D1 の `workflow_runs` / `workflow_nodes` は**索引**（一覧・検索用）で、0149 の outbox で書く。
- 定義は D1 のまま。run は start 時に版を固定して graph を読む。
- 根拠: DO の alarm / wake で再開できる。DO→D1 の制御書き込みを避ける（0145）。0149 と同じ「DO が正本・D1 は写し」。
- 代替: D1 を正本にして Worker / Queue が駆動する。バックグラウンド完了の再開に別の駆動役が要るので採らない。

### 決定 2: 実行モデル

- グラフをトポロジカルな層に分ける。層内は**並列（上限 2）**、層間は predecessor の done を待つ（join = all）。
- agent node: 1 node = 1 conversation（0146）。prompt は `{{node}}` を補間。
- tool node: project root で bash（0147 / 0157）。sandbox は 0194。
- human node: node waiting / run waiting。入力 API で resume。
- 遷移は `core/workflow.ts` の表だけを通す。保存の前に assert する。

### 決定 3: 再試行・待ち・再開

- node 失敗: 既定 2 回、backoff 1s → 4s。尽きたら node failed → run failed。
- human wait: 期限なし（設定で上限を足せる）。run は waiting で DO に残る。
- eviction / 再起動: SQLite から読み、running の node を pending に戻して再開（0017 と同じ）。二重実行は `(run, node, attempt)` の key で防ぐ。
- abort: running node を abort し、run failed。done / failed は終端。

### 決定 4: 起動と冪等

- 0161（Cron / webhook）が `startRun(firingId, workflowId, input)` を DO に送る。同じ firingId は既存 run を返す（dedupe）。
- 同時実行は workflow ごとに 1（0161 も同じ）。グローバル上限は 4 runs / project。
- 起動は queued → running。run id は DO が採番する。

### 決定 5: 索引と進捗

- 索引の行: run（id / workflowId / projectId / status / updatedAt / finishedAt）と node（runId / nodeId / status）。0149 と同じ outbox + 単調 upsert。
- 進捗は 0159 の live frame（run / node の状態）。UI は 0110 / 0111。
- 索引が遅れても実行は止めない。

### 決定 6: 依存と AC

- `depends-on` に **0156**（workspace）と **0157**（tool の write）を足す。**0161 は 0038 に依存する側**（0161 の depends は 0038, 0148）なので、0038 から 0161 へ依存を張らない（循環にする）。trigger は 0161 が持つ。
- 0038 の AC から「schedule / webhook」を外す（0161 が持つ）。0038 は「起動された後の run」に絞る。
- touches に `server/src/do/`、`store/src/`（索引）、`server/src/graphql/` を足す。

### 決定（D086）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | run の正本を DO にするか | **決定（user）**: DO。D1 は索引（0149 と同じ） | 0146 / 0149 / 0145 | 2026-11-17 |
| U-02 | schedule / webhook を 0161 に移すか | **決定（user）**: 移す。0038 は run の実行だけ | 0161 | 2026-11-17 |
| U-03 | 並列の範囲 | **決定（user）**: 層内は上限 2。最初は逐次でもよい | 0038 / 0110 | 2026-11-17 |
| U-04 | 再試行と human の期限 | **決定（user）**: 2 回 / 1s→4s、human は期限なし | 0038 | 2026-11-17 |
| U-05 | tool node を v1 に含めるか | **決定（user）**: 含める（0157 の後）。agent / human を先に通す | 0157 / 0194 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 不正な遷移（done → running 等）→ 保存しない | 高 | 受入1 |
| C2 | 同じ firingId で 2 回 start → 1 run。二重実行しない | 高 | 受入4 |
| C3 | agent node の失敗 → 2 回再試行 → 尽きたら run failed | 高 | 受入2 |
| C4 | human node → waiting → 入力 → 続きから done | 高 | 受入2 |
| C5 | DO を evict / 再起動 → running node を pending に戻して再開。二重に実行しない | 高 | 受入2 |
| C6 | 層内 2 node を並列 → join（all）→ 次へ | 中 | 受入2 |
| C7 | 索引が遅れても run は進む。再起動後に索引が追いつく | 中 | 受入3 |
| C8 | 0161 の trigger → startRun → 実行（0038 は trigger を持たない） | 中 | 0161 |
| C9 | `npm run check` | 高 | 受入5 |

層は unit（遷移 / 再試行 / dedupe）、integration（実 SQLite で crash / resume / 並列）、0161 との結合は 0161。



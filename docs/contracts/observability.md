# 契約: 観測（ObsLogEntry / 保持 / 測定窓）

2026-11-18 / L6 M2。**この面の契約の正本**。実装は `@hns/core` の `observability.ts` / `types.ts`（`EVENT_NAMES` / `OBS_HOPS` / `OBS_DETAIL_KEYS`）、`server/src/obs/*`、`machine/src/log.ts`。手順と面は [observability.md](../observability.md)、失敗の語彙は [failures.md](failures.md)。

## 形

- 1 行 = 1 `ObsLogEntry`。キーは **allowlist**（`OBS_DETAIL_KEYS` から導出した schema）。本文・ヘッダ・トークン・エージェントの応答テキストは**書かない**。
- `EVENT_NAMES` は閉じた語彙。新しいイベントは名前を足してから使う（独自 JSON で書かない）。
- hop は `OBS_HOPS` の閉じた語彙。相関 ID は edge が発番した `x-request-id` を全ホップが使う（下流で作らない）。

## 保持と量

- 保持は **30 日**、件数は **5000/ワークスペース**。append 時に上限超過だけ 1 文で消し、保持の削除は 256 回の append ごと。

## 索引の観測（`index.*`）と測定窓

- `index.rebuilt` / `index.drain.failed` / `index.state.failed` / `index.legacy_rows` は観測。`indexEntry` が `ObsLogEntry` を組み立てる。
- **測定窓は「turn の書き込みまで」**。`CostGate.turn` が測ってから `turnEnded`（drain）を呼ぶ。**失敗した drain の観測は append しない**（D1 障害で 1 ターンの行が増えると課金の測定が汚れる）。成功した drain の `index.*` は窓の外で 1 行だけ書く。
- `session-cost.test.ts` の `ROWS_PER_TURN = 10` と `deploy/limits/RESULTS.md` はこの窓の定義に従う。

## 変わったとき

イベント・detail・hop を足すなら `core` の語彙とこのファイル。測定窓を変えるなら `cost/gate.ts` と `deploy/limits/RESULTS.md` を同じ変更で。

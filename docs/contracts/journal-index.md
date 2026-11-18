# 契約: Journal と索引（intent / outcome / watermark / dirtyAt）

2026-11-18 / L6 M2。**この面の契約の正本**。実装は Workspace DO の `store/src/journal/*` + `server/src/do/journal.ts`、索引は `store/src/conversation-index/*` + `server/src/do/session-index.ts`。不変条件は [invariants.md](../invariants.md) の INV-04 / INV-09 / INV-10 / INV-11。

## Journal（Workspace DO）

- **append-only**。行は `kind`（intent / outcome / audit / event）と `seq`（DO の transaction 内で採番）を持つ。
- **INTENT が先、OUTCOME が後**（INV-04）。`operationId` で重複排除し、同じ id の再送は既存の outcome を返す。同じ id で内容（path / expectedVersion / body hash）が違えば `denied`。
- outcome の status は閉じた union（`applied` / `conflict` / `denied` / `unknown`）。`unknown` は「適用済みか分からない」で、照合以外に丸めない。
- 本文は 256KB 以下は行、超える分は R2（key は行に持つ）。
- **watermark**（`throughSeq`）までを切り詰められる。**未確定の intent を越えて進めない**（fail closed）。切り詰め後も正本は `(C, J)` で、索引・一覧は作り直せる。
- settle（outcome + 版 + event）は **1 トランザクション**（INV-10）。

## 索引（D1, 会話）

- 索引は**写し**（INV-11）。正本は Session DO。D1 の行は DO から `reindex` で作り直せる。
- DO は metadata に内部 `dirtyAt` を持ち、RPC の後に `pendingIndex`（dirty な行、1 回 50 行まで）→ D1 upsert → `markIndexed`（`dirtyAt === version` のときだけ消す CAS）を回す。
- upsert は `updated_at` の単調（遅い書き込みが新しい行を巻き戻さない）。drain は索引を先に読み、変わっている行だけ書く。
- **人が書いた列は Object が上書きしない**（0271n）。行に `edited_at` があれば、`title` / `archived` / `deleted_at` は人の値のまま（drain も `reindex` も同じ）。規則は `store/src/conversation-index/writer.ts` の `keepEdited` 1 箇所。`updated_at` / `created_at` / `indexed_at` は Object の列で、意味は変わらない。`edited_at` を消す（Object を正に戻す）操作はまだ無い。
- **索引の失敗は操作を止めない**。dirty を残し、次の RPC で再送する。失敗は観測（`index.drain.failed`）に出すが、**課金の測定窓の外**（[observability](observability.md) の「索引の観測と測定窓」）。
- 一覧は D1 のみ（`(project_id, updated_at DESC, id DESC)` の keyset）。未索引の行も一覧から落ちない。詳細は DO。
- 未知の `projectId` は D1 を読む前に `invalid_request`（DO を作らない）。

## 変わったとき

行の語彙・切り詰めの規則・索引の dirty の意味を変えるなら、このファイルと `journal/schema.ts` / `session-index.ts` の TSDoc を同時に。INV-04 / INV-11 を弱めるには決定の追記が要る。

# 月次の運用上限（コスト）

2026-11-17 / 実装 [packages/server/src/cost/](../../packages/server/src/cost/) / 契約 [docs/limits.md](../../docs/limits.md) /
背景 [docs/durability.md](../../docs/durability.md) §7。

プラットフォーム（Durable Object の行・リクエスト、R2 のオブジェクト）と provider の支出に月次の上限を置き、
**新しい Run を止める**。値はコードに無く、D1 の 1 行にある（provider は 0151 の既存の行）。デプロイは migrate だけで、
上限の変更にビルドも migration も要らない。

## 上限の置き場

| 面 | 表 | 上限の列 | 支出の列 |
| --- | --- | --- | --- |
| DO 行 | `cost_limits`（migration 3） | `do_rows_limit` | `cost_turn.do_rows` の当月 SUM |
| DO リクエスト | 同上 | `do_requests_limit` | `cost_turn.do_requests` の当月 SUM |
| R2 オブジェクト | 同上 | `r2_objects_limit` | `cost_turn.r2_objects` の当月 SUM |
| provider（USD） | `provider_gateway`（migration 2 / 0151） | `month_limit` | `month_spent`（`month_key` が当月のとき） |

`cost_limits` は 1 行（`id = 'cost'`）。既定は行 5,000万・R2 オブジェクト 100万（[docs/durability.md](../../docs/durability.md) §7 の
無料枠の桁）と、同じ桁に置いた DO リクエスト 100万（§7 の数字ではなく、この配備の運用方針）。provider の既定は
日 5 / 月 50 USD（[docs/auth.md](../../docs/auth.md)）。

## 見る（D1 に 1 文ずつ）

```sql
-- 上限とアラート閾値
SELECT * FROM cost_limits;

-- 当月の使用量（UTC の月初から翌月初まで。製品の readMonthlyTotal と同じ境界）
SELECT SUM(do_rows) AS do_rows, SUM(do_requests) AS do_requests, SUM(r2_objects) AS r2_objects
FROM cost_turn
WHERE at >= date('now', 'start of month')
  AND at < date('now', 'start of month', '+1 month');
```

provider の当月支出は [docs/auth.md](../../docs/auth.md) の運用（`provider_gateway` の 1 行）を見る。
環境ごとの D1 は `hns-dev` / `hns-stg` / `hns-prod`（Worker 名と同じ）。

## 変える（D1 に 1 文ずつ。migration は変えない）

```sql
-- プラットフォームの上限
UPDATE cost_limits SET do_rows_limit = 20000000, do_requests_limit = 500000 WHERE id = 'cost';

-- アラート閾値（0 < warn < critical <= 1。CHECK が拒否する）
UPDATE cost_limits SET warn_ratio = 0.5, critical_ratio = 0.8 WHERE id = 'cost';

-- provider の月次上限（詳細は docs/auth.md）
UPDATE provider_gateway SET month_limit = 50 WHERE id = 'gateway';
```

- 判定は「使用量 >= 上限」で止める（gateway の `spent + price <= limit` と同じ意味）。上限を下げると即座に効く。
- **すぐ全部止める**: provider の `month_limit` を `month_spent` と同じ値にする（gateway の 429 と、
  こちらの Run 拒否が同時に立つ）。provider の緊急停止は 0151 の `stopped = 1`（呼び出し単位）。
  プラットフォーム側に専用の停止フラグは置かない（上限で足りる。状態を2つにしない）。
- 月のリセットは無い: 支出は `cost_turn.at` の当月 SUM なので、月が変われば自動で 0 になる。
  writer の無いカウンタ行を作らないので、リセット漏れも無い。

## アラート

超出の判定はターン終了時にだけ走る。**閾値を跨いだターンで 1 行**、次の形でログに出る（本文・トークン・鍵は出さない）。

```text
cost: alert doRows critical 41000000 50000000
```

- 閾値は `warn_ratio`（既定 0.5）と `critical_ratio`（既定 0.8）。上限に達したら `exceeded`。
- 跨ぎの判定は「記録後の当月合計 − そのターンの分」なので、状態を持たない。再起動でも重複しない。
- 受け取り方: Cloudflare の Workers Logs、または Logpush でメッセージに `cost: alert` を含む行を拾う
  （通知先は R2 / S3 / メールなど）。アカウントの使用量ダッシュボードはアカウント全体の見え方で、
  この表（アプリが自分で数えた値）とは一致しないことがある。閾値の判定はこの表だけを見る。
- アラートは 3 段（warn / critical / exceeded）。同じ帯に留まる限り出ない。

## 縮退

- 止めるのは**新しい Run**だけ。`POST /rpc/conversations/:id/messages` が `session.send` の前に判定し、
  429 `limit_exceeded` を返す。既存の Run・abort・transcript・一覧は変わらない。
- 上限・当月合計・provider 行のどれかが読めないときは **503 `limit_unavailable`**（fail closed）。
  上限の読めない状態を「使い放題」と解釈しない。
- 記録（`cost_turn` の INSERT）が失敗してもターンは成功のまま。ログだけ残す。金額の外側の天井は
  provider 側の hard limit（[docs/auth.md](../../docs/auth.md) §gateway）。

## 記録と保持

- 1 ターン = `cost_turn` の 1 行。キーは `(conversation_id, id)` で、`id` は送信の requestId。requestId を
  付けない送信は別の行になる（再送で二重計上しないため、クライアントは requestId を付ける）。
- `cost_turn` は消さない。月次の上限の根拠で、消すと判定が過去に戻る。規模は 1 ターン 1 行（月 1 万ターンで
  1 万行、年 12 万行）。将来 GC するなら、先に月次合計を別に残してから行う。
- D1 の行数上限はこの規模より十分大きい。増え方が想定を超えたら、まず `cost_limits` の上限ではなく
  token 単位 commit のような書き込みの設計を疑う。

## 実測

1 ターンの実測と月 1 万ターンへの外挿は [RESULTS.md](RESULTS.md)（数値はここに置かない）。
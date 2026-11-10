# API shape bench: REST vs GraphQL の read 経路

2026-11-10。hns の**正本の配置**（実行中の状態は DO、確定レコードは D1、一覧は D1 の投影）を
そのまま再現し、同じ画面を REST と GraphQL のどちらで読むと何がいくつになるかを測る。
製品コードではない（[AGENTS.md](../../../AGENTS.md) の work/poc 扱い）。採否の判断はここではしない。

## 何を再現しているか

```text
bench ─┬─ REST server（1 画面 1 route、必要な項目だけ返す）
       ├─ GraphQL server（graphql-js 1 endpoint、resolver の 3 形態）
       └─ Session actor × 12（Durable Object の代役。live 状態を HTTP RPC で返す）
                 │
       projecton（node:sqlite）: 確定レコード + live の射影（mirror）
```

- live 状態を持つのは **Session actor（1 ワークスペースに 1 つ）** だけ。読みは必ず RPC。
- 確定レコードは SQLite の射影。live の mirror は**別ジョブが一定間隔で書く**（D049 の「実行中の状態は
  DO、確定したレコードは D1」を保つため、mirror は遅れる）。
- 同じ画面（0115 の overview）を、同じ合成関数（`src/compose.mjs`）で組み立てる。
  プロトコルの差だけが残るように、REST 側にも mirror だけを読む route を置いてある。

## 走らせ方

```bash
cd work/poc/graphql-relay
pnpm add graphql@16.11.0 dataloader@2.2.3 --store-dir ./.pnpm-store   # 初回だけ
CONVS=40  ITERS=150 node src/bench.mjs
CONVS=120 ITERS=150 node src/bench.mjs
node src/cost.mjs        # results-*.json を読んで月額を出す
```

結果は `results-40.json` / `results-120.json`、読み方は [RESULTS.md](RESULTS.md)。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/model.mjs` | 12 ワークスペース / N 会話 / 60 task / 30 run の決定的 seed。型は core の schema に合わせた |
| `src/projection.mjs` | D1 の代役。確定レコードと live の mirror |
| `src/compose.mjs` | 0115 の overview 合成。REST と GraphQL で共有 |
| `src/session.mjs` | Session actor（DO の代役）。`/rpc/status-one` と `/rpc/status`（まとめ読み） |
| `src/rest.mjs` | 1 画面 1 route の REST |
| `src/gql.mjs` | graphql-js。resolver の形態は `fanout` / `batch` / `d1` / `records` |
| `src/bench.mjs` | 計測、staleness、mirror の書き込み量、LOC |
| `src/cost.mjs` | DO / D1 の料金（2026-11-10 に docs から取得）と、measured な行数・RPC 数から月額を出す |

## 測っていないもの（ここで結論を出せない理由）

- **Cloudflare の実レイテンシと課金**。RPC は loopback なので 1 回 0.05ms 程度。実測値は
  [cf-harness/RESULTS.md](../cf-harness/RESULTS.md) の 28ms p50 / 61ms p95 を使い、RESULTS.md で式として扱う。
- **DO の subrequest 上限・同時接続上限**。回数だけを事実として出す。
- **Relay（クライアント）**。正規化 store、fragment、subscriptions、codegen、persisted query は未計測。
  このハーネスが測っているのは**サーバ側の形**だけで、Relay を採るかは別の問い。
- **認可**。field 単位の認可面、深さ・複雑度の上限は未実装。
- **エラー経路**。RFC 9457 / ErrorCode と GraphQL の union の差は測っていない。

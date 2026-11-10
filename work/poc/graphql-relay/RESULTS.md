# 計測結果

2026-11-10。Node v24.11.1、`ITERS=200`、すべて loopback。生データは `results-40.json` / `results-120.json`。
構成と限界は [README.md](README.md)。

条件: 12 ワークスペース（Session actor 12 個＝DO の代役）、mirror 間隔 1000ms、
画面は 0115 の overview（needs / running / completed / counts）。
**同一の field set で比べる**ため、REST 側にも summary（4 項目）route と records-only route を置き、
GQL 側にも 7 項目 query を置いた。時刻は p50 / p95（ms）、バイトは応答本文。

## 1. overview 画面（40 会話）

| 経路 | client req | DO RPC | p50 | p95 | bytes |
| --- | --- | --- | --- | --- | --- |
| REST `/api/state` を会話ごと（0115 が置き換えたい形） | 40 | 40 | 9.83 | 15.74 | 30679 |
| REST `/api/live` を会話ごと（1 会話の live だけ） | 40 | 40 | 7.21 | 12.74 | 3753 |
| REST `/api/overview`（RPC を WS ごとにまとめる） | 1 | 12 | 1.24 | 1.53 | 3620 |
| REST `/api/overview`（RPC を会話ごと・並列） | 1 | 40 | 3.23 | 7.50 | 3620 |
| REST `/api/overview`（RPC を会話ごと・直列） | 1 | 40 | 6.21 | 10.97 | 3620 |
| REST `/api/overview`（mirror だけ） | 1 | 0 | 0.33 | 0.36 | 3620 |
| GQL overview fan-out | 1 | 40 | 3.56 | 8.94 | 3642 |
| GQL overview batch | 1 | 12 | 1.59 | 2.53 | 3642 |
| GQL overview mirror のみ | 1 | 0 | 0.59 | 0.70 | 3642 |
| REST `/api/overview-records`（live なし） | 1 | 0 | 0.27 | 0.30 | 2340 |
| GQL overview records のみ | 1 | 0 | 0.51 | 0.57 | 2362 |

120 会話:

| 経路 | client req | DO RPC | p50 | p95 | bytes |
| --- | --- | --- | --- | --- | --- |
| REST `/api/state` を会話ごと | 120 | 120 | 30.24 | 41.26 | 92160 |
| REST `/api/live` を会話ごと | 120 | 120 | 23.69 | 34.48 | 11033 |
| REST overview（WS ごと） | 1 | 12 | 1.52 | 2.07 | 3620 |
| REST overview（会話ごと・並列） | 1 | 120 | 9.39 | 15.32 | 3620 |
| REST overview（会話ごと・直列） | 1 | 120 | 18.91 | 25.25 | 3620 |
| REST overview（mirror） | 1 | 0 | 0.52 | 0.76 | 3620 |
| GQL overview fan-out | 1 | 120 | 10.51 | 16.73 | 3642 |
| GQL overview batch | 1 | 12 | 1.86 | 3.23 | 3642 |
| GQL overview mirror | 1 | 0 | 0.82 | 1.16 | 3642 |
| REST overview-records | 1 | 0 | 0.41 | 0.66 | 2340 |
| GQL overview records | 1 | 0 | 0.69 | 0.77 | 2362 |

looppback の p50 は実行間で ±50% 動く（同一マシンで他プロセスが走ると GQL batch が 1.6→2.7ms になった）。
**1ms 未満の差はこの環境では判定に使えない。**

## 2. 会話一覧 + 行ごとの live

40 行:

| 経路 | client req | DO RPC | p50 | bytes |
| --- | --- | --- | --- | --- |
| REST `?includeLive=1`（7 項目 + live） | 1 | 12 | 1.23 | 10928 |
| REST `?fields=summary&includeLive=1`（4 + live） | 1 | 12 | 1.19 | 7808 |
| GQL 7 項目 + live（batch） | 1 | 12 | 1.63 | 10795 |
| GQL 4 項目 + live（batch） | 1 | 12 | 1.59 | 7795 |
| GQL 3 項目 + live（batch） | 1 | 12 | 1.55 | 7119 |
| GQL 3 項目 + live（fan-out） | 1 | 40 | 3.66 | 7119 |
| GQL 3 項目 + live（mirror） | 1 | 0 | 0.62 | 7119 |

120 行: REST 7+live 32586 / 4+live 23226、GQL 7+live 32133 / 4+live 23133 / 3+live 21103。

## 3. sidebar: 1 プロジェクトの Conversation

| 経路 | p50 | bytes(40 会話) | bytes(120 会話) |
| --- | --- | --- | --- |
| REST 7 項目 | 0.14 | 751 | 1880 |
| REST 4 項目（summary route） | 0.15 | 439 | 1100 |
| GQL 7 項目 | 0.31 | 762 | 1867 |
| GQL 4 項目 | 0.30 | 462 | 1117 |

## 4. 何がコストを決めているか

- **DO RPC の本数はプロトコルで決まらない。** 同じまとめ方なら一致する（12 対 12、40 対 40、120 対 120）。
  変わるのはまとめ方を変えたときだけ（0 / 12 / 40 / 120）。
- **client req を 1 本にするのは両方でできる。** 会話ごとに 1 本になるのは `/api/state` / `/api/live` の形だけで、
  これは REST 固有ではない（GQL でも会話ごとに解決すれば同じだが、その場合でも client req は 1 本にできる）。
  0115 の「会話ごとに `/api/state` を呼ばない」は、REST の集約 endpoint でも GQL でも 1 req / 12 RPC になる。
- **差が出るのは route の本数。** このハーネスで同じ画面群を出すのに REST は route 6 本
  （`/api/state`・`/api/live`・`/api/overview` ×3 形態・`/api/overview-records`・`/api/conversations`）、
  GQL は 1 endpoint と query の形。
- **同一 field set なら payload はほぼ同じ。** 差は −1.2%〜+5.2% で、向きも一定しない
  （§5）。GQL の応答は `{"data":{"overview":…}}` の wrapper を持つ分だけ少し大きい。
- **画面が少数の項目しか要らないなら、REST は専用 route を足す必要がある**（summary route 439B vs 全項目 751B）。
  GQL は query を短くするだけで同じ結果になる。ここが route 本数と表裏。

## 5. payload の比較（同一 field set）

| 画面 | REST | GQL | 差 |
| --- | --- | --- | --- |
| overview（40 会話） | 3620 | 3642 | +0.6% |
| overview-records | 2340 | 2362 | +0.9% |
| sidebar 7 項目（40） | 751 | 762 | +1.5% |
| sidebar 4 項目（40） | 439 | 462 | +5.2% |
| 一覧 4 + live（40） | 7808 | 7795 | −0.2% |
| 一覧 7 + live（40） | 10928 | 10795 | −1.2% |

**field set を揃えると、プロトコルによる payload 差はない。** 以前に「-8.7% / -38%」と見えたのは
GQL の query が項目を要求していなかっただけで、バイト数ではなく**選択の差**だった。

## 6. graphql-js の固定費（I/O なし）

| 項目 | p50 | p95 |
| --- | --- | --- |
| overview query 全体（parse + validate + execute、38 項目） | 0.17ms | 0.25ms |
| validate のみ | 0.09ms | 0.10ms |

28ms/RPC の 0.6%。この規模では判断材料にならない。

## 7. live を落とすと何が失われるか

authoritative な needs は 8 件。うち **6 件は live 状態からしか作れない**
（waiting_human 3 / run_failed 2 / conversation_blocked 1）。2 件は確定レコードだけで作れる（task_blocked）。

| 読み方 | needs 件数 | 鮮度 |
| --- | --- | --- |
| live を RPC で読む | 8 | 現在 |
| D1 の mirror を読む | 8 | **mirror 間隔の分だけ遅れる**（実測: 36〜929ms、1000ms 間隔に対してほぼ一様） |
| 確定レコードだけを読む | 2 | 現在（6 件は表現できない） |

## 8. mirror の書き込み量（D1）

| 会話数 | 行/ティック | 行/秒 @1s | 行/日（換算） |
| --- | --- | --- | --- |
| 40 | 40 | 40 | 3,456,000 |
| 120 | 120 | 120 | 10,368,000 |

**活動量に関係なく一定。** 100ms 間隔なら 10 倍、10 秒なら 1/10。イベント駆動なら暇なときは減る。
[cf-harness](../cf-harness/RESULTS.md) と [D048](../../../docs/decisions.md) の
「イベントごとの D1 同期更新」への警告は、この行数が対象。

## 9. 実装量

| ファイル | 行（空行・コメント除く） |
| --- | --- |
| `rest.mjs`（route 6 本 + 計測用 variant） | 141 |
| `gql.mjs`（resolver + 配線） | 105 |
| SDL | 12 |
| `compose.mjs`（業務規則。両方で共有） | 47 |

## 10. コスト（DO / D1）

料金は 2026-11-10 に Cloudflare の docs から取得（DO: 2026-10-18 更新、D1: 2026-10-30 更新）。
再現は `node src/cost.mjs`。行数と RPC 数は §1〜§8 の実測、料金は定数。

前提（Workers Paid）:

| 項目 | 含まれる量 | 超過 |
| --- | --- | --- |
| DO requests | 1,000,000 / 月 | $0.15 / million |
| DO duration | 400,000 GB-s / 月 | $12.50 / million GB-s |
| DO / D1 rows read | 25,000,000,000 / 月 | $0.001 / million |
| DO / D1 rows written | 50,000,000 / 月 | $1.00 / million |
| D1 storage | 5 GB | $0.75 / GB-月 |

### 10.1 DO requests（画面 1 回あたりの本数 × 回数）

| loads/月 | batched 12 RPC | 会話ごと 40 | 会話ごと 120 | mirror 0 |
| --- | --- | --- | --- | --- |
| 6,000 | $0 | $0 | $0 | $0 |
| 60,000 | $0 | $0.21 | $0.93 | $0 |
| 300,000 | $0.39 | $1.65 | $5.25 | $0 |

DO duration は 300,000 loads/月でも $0（内訳: 12 RPC × 5ms × 0.125 GB = 0.0075 GB-s/load）。
WebSocket は接続が 1 request、**送信は無料**、受信は 20:1（100 メッセージ = 5 リクエスト）。
10/s を 8 時間/日でも 432,000 request/月 = $0。

### 10.2 D1 rows written（ここだけが問題になりうる）

mirror を「全スナップショットを一定間隔で」書いた場合（§8 の実測どおり 40/120 行/ティック）:

| 会話数 | 1s | 2s | 5s | 10s | 60s |
| --- | --- | --- | --- | --- | --- |
| 40 | **$53.68** | $1.84 | $0 | $0 | $0 |
| 120 | **$261.04** | $105.52 | $12.21 | $0 | $0 |

mirror が Session を読む DO requests も足すと（12 ワークスペースを間隔ごとにポーリング）:

| 会話数 | 間隔 | DO $ | D1 $ | 合計 |
| --- | --- | --- | --- | --- |
| 40 | 1s | $4.52 | $53.68 | **$58.20** |
| 40 | 2s | $2.18 | $1.84 | $4.02 |
| 40 | 5s | $0.78 | $0 | $0.78 |
| 40 | 10s | $0.32 | $0 | $0.32 |

dirty-set（変わった行だけ書く）にすると、会話あたり 1〜60 回/時の変更では **$0**（§10.3 のモデル）。

### 10.3 閾値

- D1 writes が $0 に収まるのは **50,000,000 行/月** = 1s 間隔なら **19 会話**、5s なら 4 会話。
- D047 の **$50/月** に当たるのは 1s 間隔で **39 会話**。40 会話の 1s mirror は $53.68 で超える。
- D1 の無料枠は 100,000 行 written/日。40 会話の 1s mirror は 3,456,000 行/日 = **34.6 倍**。無料枠では動かない。

### 10.4 言えること

- **DO は問題にならない。** 最も高い経路（会話ごと fan-out 120 RPC × 300,000 loads/月）でも $5.25/月。
- **D1 は 1 点だけ問題になりうる。** 全スナップショットの mirror を 1s で回すと 40 会話で $53.68/月（DO のポーリング込みで $58.20）、
  120 会話で $261。これは **mirror の方針のコストで、API の形（REST / GQL）とは無関係**。
- 2 つのプロトコルでコストが違うのは DO requests の 12 対 40/120 だけで、差は最大 $5.25/月。
  D1 の書き込み量と読み取り量は、どちらのプロトコルでも同じ（mirror を読む限り）。

## 11. この計測で言えること

1. 1 request にするのは REST の集約 endpoint でも GQL でもできる。差は route の本数。
2. DO RPC の本数を決めるのはプロトコルではなく resolver のまとめ方（0 / 12 / 40 / 120）。
3. field set を揃えると payload 差は −1.2〜+5.2% に収まり、向きも一定しない。
   「GQL は payload が小さい」は、この規模では**成り立たない**（選択を変えたときだけ差が出る）。
4. graphql-js の実行時コストは 28ms/RPC の 0.6%。
5. live を落とすと needs 8 件のうち 6 件が作れない。mirror は件数を保つが 1 間隔ぶん古い。
   その代金は D1 の行数（40 会話で 3.46M 行/日 @1s）。
6. この環境の loopback レイテンシは 1ms 未満の差を判定できない。実デプロイの 28ms/RPC では、
   p50 を分けるのは「1 request か n request か」「並列か直列か」で、課金を分けるのは RPC 本数。

## 12. この計測で言えないこと

- Cloudflare 上の実レイテンシ・実課金（28ms は既存実測の借り物）。クライアント側の波の数も未計測。
- **Relay**（正規化 store・fragment・subscriptions・codegen・persisted query）。サーバ側の形しか測っていない。
- 認可（field 単位）、深さ・複雑度の上限、エラー経路（RFC 9457 / ErrorCode と GraphQL union の差）。
- 「どちらを採るか」。1〜6 は採否を決めていない。

## 13. 独立レビューの指摘と、直したこと

`fairness-check`（このハーネスを書いていない別エージェント）に非対称の検査を依頼した。

| 指摘 | 対応 |
| --- | --- |
| `/api/state` の N+1 が hollow（messages/tasks が空、counts が固定） | messages 6 件 + tasks 3 件 + 実 count を返すようにした。さらに lean な `/api/live` の N+1 を追加 |
| byte 列が field set の違いを測っていた | GQL 側に `reason` を要求し、同一 field set で比較し直した（§5） |
| sidebar が 7 項目 vs 4 項目で比較されていた | REST に summary route、GQL に 7 項目 query を追加し、4 対 4・7 対 7 で比較 |
| GQL だけの行があった | REST に records-only route・`?includeLive=1`・summary route を追加 |
| mirror が計測窓の中で走っていた | 計測中は mirror を止め、staleness と書き込み量のときだけ動かす |
| GQL が毎要求 `await import()` していた | トップレベル import に変更 |
| `results-120.json` の metadata が 40 と書かれていた | run の値から書くように修正 |
| クライアント側の parse がタイマー内 | 残した（どちらの経路も同じ処理を通る。バイト比例なので、payload が同じなら影響も同じ） |

## 14. mirror なしで Relay + GraphQL を通した結果

`relay/over-http.mjs`。D1 の mirror を一度も書かずに（mirror への書き込み 0 回）、
PoC の GraphQL endpoint に Relay から接続した。

| scenario | HTTP | DO RPC |
| --- | --- | --- |
| sidebar 初回（live を選ばない） | 1 | 0 |
| sidebar を再度開く | 0 | 0 |
| panel（live が必要、store に無い） | 1 | 1（p-01 の 4 会話を 1 RPC にまとめ） |
| panel を再度開く | 0 | 0 |
| overview（home）初回 | 1 | **12** |
| overview を再度開く | 0 | 0 |
| sidebar を network-only で再取得（fan-out） | 1 | 0 |
| panel を network-only で再取得（fan-out） | 1 | 4 |

- **mirror への書き込みは 0。** overview は needs 8/8 を表示した。つまり mirror は無くても画面は成立する。
- 初回は 12 RPC（= ワークスペース数）、再訪は 0。Relay が減らすのは**繰り返しの要求**であって、
  サーバ側の読みの出所ではない。
- この実行で Relay が警告を出した: 同じ id `c-001` を `Conversation` と `Item` の両方の
  record に使ったため、正規化 store が衝突した。**Relay は全型で一意な id（node interface /
  global id）を要求する。** PoC の `Item.id` は会話 id をそのまま返していた。

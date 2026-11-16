# 0181: store の鮮度方針を画面ごとに決める

status: open
priority: next
design: agreed
design-ref: D097
depends-on: 0159, 0179
touches: packages/web/src/live/, packages/web/src/app/, packages/web/test/

## Goal

Relay の store は、満たせる要求を network に行かない。実測では再訪 0 回。これは DO RPC を減らすが、
裏返すと**古いデータを出したまま何も聞きに行かない**。鮮度が意味を持つ画面（Needs you など）で
どう更新するかを決める。

## Acceptance criteria

- [ ] store が古いまま表示されるケースを列挙する（再訪、購読の取りこぼし、切断中の変更）
- [ ] 画面ごとに「購読（0159）」か「明示的な再取得」を決め、テストで固定
- [ ] 切断・再接続時の表示を決める（状態を隠さない）
- [ ] `store-or-network` の既定を画面ごとに変えられるようにする
- [ ] `npm run check` が通る

## Notes

- 実測: store-or-network で再訪 0、既定ポリシーで毎回 1（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §13）
- 0159 の WS は送信が無料・受信が 20:1 なので、購読に寄せると DO 課金は増えない
- 索引（0149）の遅れと store の古さは別の層。両方を説明できるようにする

## Design（D097 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D097）。

### 前提

- Relay の store-or-network は再訪 0 回（PoC RESULTS §13）。裏返すと**古いまま何も聞かない**。
- 0159 の WS は live frame（snapshot / append / delta / error）と client→server の `ping` / `resync`。
- 0149 の D1 索引の遅れと、Relay store の古さは**別の層**。両方を説明できるようにする。

### 決定 1: 古いまま出るケース

1. 同じ画面を再訪（store が残っている）
2. WS の取りこぼし（切断中の frame、reconnect の隙間）
3. 別タブ / 別端末 / agent の変更
4. 索引（0149）の反映遅れ
5. 画面を開いたまま時間が経つ（Needs you など）

### 決定 2: 画面ごとの方針

| 画面 | 初回 | 更新 | 根拠 |
| --- | --- | --- | --- |
| 会話の transcript | network | **購読**（0159）+ reconnect で resync | 変更が速い |
| 会話一覧 / ホーム / Needs you | store-and-network | **購読**（一覧の追加・状態）+ 変更後に refetch | 古いと判断を誤る |
| Settings / providers / machines | store-and-network | 30 秒 TTL + focus / 表示時に revalidate。購読しない | 変更が遅い |
| Editor の本文 | network（版付き） | 保存の conflict で検出。store に載せない | 版が正本 |
| file tree | network（展開ごと） | 購読しない。操作後に再取得 | 0125 の lazy |

- `store-or-network` を既定にし、画面ごとに `network-only` / `store-and-network` を選べるようにする（query の fetchPolicy）。

### 決定 3: 切断・再接続

- 切断中は **最後のデータ + 「再接続中（古い可能性）」** を出す。状態を隠さない。
- 再接続で `resync` を送り、**開いている画面を refetch** する。取りこぼしを store の差分だけで埋めない。
- `error` frame / close は型付きで UI に出す。

### 決定 4: 索引の遅れ

- 一覧は D1 索引（0149）を読む。索引が遅れている間は「更新中」を出し、WS の live で開いている会話だけ先に更新する。
- 索引の遅れを store の古さと混ぜない（別のバナー / 別の説明）。

### 決定 5: 取得の作法

- ポーリングをしない。focus / visibilitychange / 明示操作 + TTL で revalidate。
- 画面を離れたら購読と in-flight を abort する。

### 決定（D097）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 既定の fetchPolicy | **決定（user）**: store-or-network。画面ごとに上書き | 0179 / 0105 | 2026-11-17 |
| U-02 | 購読する画面 | **決定（user）**: transcript / 一覧 / ホーム。設定・machine は購読しない | 0159 | 2026-11-17 |
| U-03 | reconnect の resync | **決定（user）**: `resync` + 開いている画面の refetch | 0159 | 2026-11-17 |
| U-04 | 古さの表示 | **決定（user）**: 「再接続中」「更新中」を別々に。黙って出さない | 0105 / 0110 | 2026-11-17 |
| U-05 | TTL | **決定（user）**: 設定系は 30 秒。focus で revalidate | 0114 | 2026-11-17 |

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 再訪 → store のデータ → 画面方針どおりに refetch / 購読が動く | 高 | 受入1・2 |
| C2 | WS を切る → 変更 → 再接続 → resync + refetch で最新になる | 高 | 受入3 |
| C3 | 切断中 → 「再接続中（古い可能性）」が出る。黙って古い値を出さない | 高 | 受入3 |
| C4 | 設定画面 → 30 秒以内の再訪は store、focus で revalidate | 中 | 受入4 |
| C5 | 索引の遅れ → 「更新中」が出て、store の古さと混ざらない | 中 | 受入4 |
| C6 | 画面を離れる → 購読 / in-flight が abort される | 中 | 受入5 |
| C7 | `npm run check` | 高 | — |

## Log

- 2026-11-17: D097 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

## やらないこと

- offline-first / 楽観更新の一般化

## Log

- 2026-11-10: 作成（user。D055）。

# 0140: 正本を Cloudflare に置く決定と docs の書き換え

status: done
depends-on: —
touches: docs/decisions.md, ARCH.md, README.md, docs/topology.md, docs/packages.md, docs/durability.md, docs/auth.md, docs/engineering.md, docs/testing.md

## Goal

[D047](../../docs/decisions.md) を決定として残し、要件・所有境界・トポロジの記述をそれに合わせる。
以後の issue はこの記述を契約として実装する。

## Acceptance criteria

- [x] `docs/decisions.md` に D047 を追記（正本の範囲・実行は手元・durable の単位・lease・鍵・索引・WS・失うもの）
- [x] ARCH.md の所有境界表に Cloudflare（DO / R2 / D1）を入れ、INV-05 の「Run 境界で commit 化されるまで durable でない」を追記
- [x] README の要件1を「UI とサーバのコードは自前、データの正本は Cloudflare アカウント、実行は自分のマシン」に書き換え
- [x] `docs/topology.md` に A'' （中央ループ + 外向き接続の ExecutionEnv）を追加し、SSH 経路が使えない理由を書く
- [x] `docs/packages.md` の目標グラフに `machine`（マシン側エージェント）を足し、server が Worker と DO を含むことを書く
- [x] D048/D049（正本の単位・DO を調整の単位に限定）を decisions と ARCH に反映
- [x] D050 で接続・計算・SSE の言い方を訂正し、tailnet を履歴に

## Notes

- 決定の根拠は [RESULTS.md](../poc/cf-harness/RESULTS.md)。実デプロイで 1 op 28ms（p95 61ms）、1 ターン 4 op で 181ms。
- 「セルフホスト」の言葉は残すが、意味を限定する。Cloudflare アカウント無しでは会話が動かないことを明記する。
- D004（まず A）は A'' に置き換わる。D016（tailnet 認証）は 0158 で置き換える。D039（pi-durable 一択）は維持。
- D049 で DO は Session と Workspace の 2 クラスに限定。`docs/packages.md` の server は Worker と DO を含む。

## 未確定

- U-23: Cloudflare アカウントとゾーンの前提を、利用者にどこまで要求するか / 個人アカウント1つを仮定 / 影響: 導入手順 / トリガー: 0160 の配布.
- U-24: 会話のデータ所在地（日本の colo に固定できるか）/ `locationHint` の可否 / 影響: 法務・遅延 / トリガー: 0146.

## やらないこと

- 個々の契約（0141 以降）をここで決めない。
- ARCH の全面書き換えはしない。差分だけ入れる。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: D047–D049 を決定に追記。ARCH を書き換え（所有境界・INV-09〜11・保存先の割り当て）。topology に A''。README の要件1と前提。packages.md に `machine` と server の Worker/DO。
- 2026-11-07: 独立レビュー 1回目 FAIL（B1–B6）。durability の DO/D1 二重定義、packages の tailnet、decisions のリンク切れ、D010 の SSE、TCP の断定、BOARD の旧決定。修正。
- 2026-11-07: 2回目 FAIL（R1–R5）。D050 が並行作業と衝突して訂正が消えていた。**D053** を追記して再訂正。testing / auth / engineering の古い前提を修正。
- 2026-11-07: 3回目 FAIL（R6）。0148 の「cloudflared は常時接続ではない」を D053 に合わせる。
- 2026-11-07: 4回目 **PASS**。

## Result

- 決定: D047（正本を Cloudflare に）、D048（`(C, J)` と ack）、D049（DO は調整の単位に限定）、D053（接続・計算・SSE の言い方の訂正）。
- ARCH を書き換え（所有境界・保存先の割り当て・INV-09〜11・M6）、topology に A''、README の要件1・前提・やらないこと、packages を 7 パッケージ（`machine`）、durability を新設（0141 の契約）。
- **独立レビュー: docs-reviewer / PASS / HEAD 34b670c（作業ツリー）**。
  - 1回目 FAIL（B1–B6）: durability の DO/D1 二重定義、packages の tailnet、decisions の 0166 リンク切れ、D010 の SSE 未置換、TCP の断定、BOARD の旧決定。すべて修正。
  - 2回目 FAIL（R1–R5）: D050 が並行作業（commit gate）と衝突し、訂正が失われていた。**D053** を追記して上書き。testing / auth / engineering の古い前提も修正。
  - 3回目 FAIL（R6）: 0148 の「cloudflared は常時接続ではない」が D053 と矛盾。修正。
  - 4回目 PASS（blocking 0）。
- 残件は [0173](0173-docs-followups.md)（古い issue の相対リンク、AGENTS / 0032 の 6 パッケージ表記、engineering の integration 層、低の保守性）。
- `npm run check` は未実行。docs のみで対象パッケージが無いため（gate は staged paths で選ぶ）。

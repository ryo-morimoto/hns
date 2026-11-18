# 0249: Artifacts B の観測・kill switch・ローカルシミュレータ

status: in-progress
priority: now
design: agreed
design-ref: lead 裁定 / D106 / 0246 / 0247 / 0248
depends-on: 0246, 0247
touches: packages/server/src/artifacts/observability.ts, packages/server/src/artifacts/kill-switch.ts, tools/deploy/cloudflare.config.ts, tools/deploy/package.json, packages/server/test/integration/artifacts-local.test.ts, docs/observability.md

## 設計（lead の裁定）

- **U-02（kill switch の単位）は仮説どおり**: **env 既定 + workspace override**。`kill-switch.ts` に 1 つの判定を置き、**mirror を試みないだけで checkpoint は成功**。**既存の pending は保持し、データを失わない**。
- **U-01（local simulator の基盤）は `cf dev` に寄せる**（既に `tools/test/cf-dev.ts` があり、gate の integration は 1 ファイルずつ実行している）。**wrangler の最小プロジェクトを別に立てない**。**`wrangler` 4.163+ で `remote: false` の Artifacts が使えない場合は、その事実を記録して skip**（CI は Cloudflare アカウントを使わない）。
- **観測**は既存の `/api/events` / `/api/metrics` に合わせ、**p95 / 失敗率 / skip 率 / repo 数を出し、token は出さない**（0246 の redaction と同じ規則）。
- **0249 は 0246 / 0247 / 0248 の起動配線も持つ**: mirror の記録と push の起動、`TrailChange` を書く writer のうち**この issue の範囲内で必要なもの**はここで決めて報告（**範囲外なら issue を分ける**）。

## Intent

B は two-way door だが、止める手段と測る手段がなければ判断できない。ミラーを即座に止める kill switch、push の p95 / 失敗率 / skip 率、ローカルシミュレータでの push / read の統合テストを用意する。

## Goal

env / workspace 単位でミラーを止められるようにし、mirror の結果を観測に載せる。wrangler の Artifacts local simulator で create / push / read を CI に通す。

## Acceptance criteria

- [x] kill switch（env 既定 + workspace override）で新しい mirror を止められる。既存の pending は保持し、データを失わない
- [x] mirror の p95、失敗率、skip 率、repo 数を観測に出す（token は出さない）
- [x] local simulator（remote=false）で repo create → push → binding read が通る
- [x] local simulator の実行基盤を決める（wrangler 4.163+ / Vite / vitest。cf 1.0.0-beta では不可ならその旨を記録）
- [x] CI では Cloudflare アカウントを使わない

## テスト条件

- C1: Given kill switch on、When checkpoint、Then mirror を試みず、checkpoint は成功（リスク: 停止できない）
- C2: Given push 失敗、When 観測、Then failure rate が上がり token は出ない（リスク: 秘密・見えなさ）
- C3: Given local simulator、When create / push / read、Then commit が読める（リスク: 開発環境）

## テスト設計

- T1: C1 / unit / kill switch
- T2: C2 / unit / metrics + redaction
- T3: C3 / integration / wrangler local

## Notes

- `tools/deploy` の wrangler は 4.156.0。local Artifacts は 4.163.0+。`cf` の config は `bindings.artifacts` を持つが、local simulator の経路は別に確認する。
- 観測の置き場は既存の event / metrics に合わせる。
- kill switch は B の撤退条件（D106）を運用で実行するためのもの。

## 未確定

- U-01: local simulator を wrangler 単体で回すか、cf dev に寄せるか / 仮説: wrangler の最小プロジェクトで CI / 影響: 開発体験 / 責任者: user / トリガー: 実装前
- U-02: kill switch の単位（env / workspace / repo）/ 仮説: env 既定 + workspace override / 影響: 運用 / 責任者: user / トリガー: 実装前

## やらないこと

- LFS
- Artifacts 正本（C）
- bit / dgit

## Log

- 2026-11-17: 作成（B3 の分割）。design pending（local simulator の基盤待ち）。

## Result

- verdict: **PASS**（reviewer-0249。初回 FAIL 1（観測が production で 0 行）→ 修正 → PASS）
- HEAD: fa41ed4（main に ff 統合）。gate は exit 0（1780 tests / 1781、main で 160.8s）。
- **C1（kill switch）**: 判定は 1 か所。**env 既定（厳密に "on"）+ workspace override**（`POST /rpc/checkpoint/switch`、**内部 route のみで公開面は無い**）。**prepare のたびに読む**ので deploy なしで止まる。off は **target を出さないだけ**で checkpoint は成功し、**pending は保持**され、binding は一度も呼ばれない。
- **C2（観測）**: **1 ミラー結果 = 1 行**を、**sink があればそこへ、無ければ console**（**sink が throw しても console に落ちる**）。detail は mirror / repos / failure のみで、**token も remote も型に無い**。`/api/metrics` に **p95（HTTP と同じ式、skipped は除く）/ 失敗率 / skip 率 / リポジトリ名の種類数**。
- **C3（ローカル）**: **cf dev に寄せた**（別プロジェクトを立てない）。シミュレータが無い環境では**理由を print して skip**、**`HNS_REQUIRE_ARTIFACTS_SIMULATOR=1` で fail**。CI はアカウントを使わない。
- **U-01 の実測（著者の記録で、レビュー担当は 4.164 を検証していない）**: wrangler **4.156**（cf 1.0.0-beta.28 同梱）は artifacts binding に `dev` を受け付けない / **cf 1.0.0-beta.28** は `dev` を受け取るが wrangler 設定へ下ろす時に落とすので cf dev は常に remote / **4.164** は `[artifacts.dev] remote=false` で local に起動するが **create が「needs to be run remotely」**。**結論: 4.163+ でも local で create → push → read は通らない**。
- **0248 の申し送り①**: writer 側の `ArtifactsBinding` を実 binding に揃えた（`get` は NOT_FOUND を throw、`log(opts?)` は全 optional、fake も同じ形）。既存テストは無変更で通る。
- **レビューで直したもの**: ①観測が production で 0 行（`sink === undefined` で return、`observe` の配線が無い、docs と逆、C2 はテストが手で `store.append`）②`metrics.repos` の語 ③p95 の式と TSDoc の不一致 ④新規コードの issue 番号 ⑤C3 が「理由の分からない失敗」になり得た。
- **実運用ではまだ起動しない**: ①**`observe` sink の production 配線**（edge → Workspace の obs）が無く、行は console まで ②**mirror の記録と push の起動配線**（Worker → machine の `op:"mirror"` transport / face の mirror 経路）③**`TrailChange` の production writer** ④Artifacts の実 binding は未検証。**BOARD で「使える」と書かない**。
- **残件**: SQL の二系統 / switch の bind 前の書き込み / sink が throw したときのテストと「二重書きしない」テスト（レビュー NB1 / NB2、1 本ずつで閉じられる）/ U-01 の版別記録を test の TSDoc に戻す。

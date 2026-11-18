# 0249: Artifacts B の観測・kill switch・ローカルシミュレータ

status: open
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

- [ ] kill switch（env 既定 + workspace override）で新しい mirror を止められる。既存の pending は保持し、データを失わない
- [ ] mirror の p95、失敗率、skip 率、repo 数を観測に出す（token は出さない）
- [ ] local simulator（remote=false）で repo create → push → binding read が通る
- [ ] local simulator の実行基盤を決める（wrangler 4.163+ / Vite / vitest。cf 1.0.0-beta では不可ならその旨を記録）
- [ ] CI では Cloudflare アカウントを使わない

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

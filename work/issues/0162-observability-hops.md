# 0162: 観測（相関 ID を全ホップに通す）

status: open
priority: plan
design: agreed
design-ref: docs/observability.md
depends-on: 0145, 0147
touches: packages/server/src/obs/, packages/core/src/observability.ts, packages/machine/src/log.ts

## Goal

障害箇所が6段（browser / edge / DO / tunnel / agent / fs）に増えるので、1つの ID で追えるようにする。

## Acceptance criteria

- [ ] 相関 ID を browser → Worker → DO → agent → fs まで通す
- [ ] イベントの語彙を core に閉じた union で置く
- [ ] 本文・ヘッダ・トークンをログに残さない（パスと status だけ）
- [ ] DO のログと agent のログを同じ形で読める
- [ ] 「どこで詰まったか」を1コマンドで出せる
- [ ] 保持期間と量の上限

## Notes

- 0028 の events 集約を引き継ぐ。0039 の製品化はここに含める。

## やらないこと

- 外部への送出（OTel 等）。
- メトリクスの可視化 UI。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

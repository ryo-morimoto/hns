# 0166: 移行とロールバック（ローカル実装を残す）

status: open
priority: plan
depends-on: 0150, 0157
touches: packages/server/src/runtime/, packages/store/test/parity/

## Goal

Cloudflare を正本にしても、テストと開発はローカルで回せる状態を保つ。
戻せることを保証する（ExecutionEnv と Storage が境界）。D1 の制御データと DO の実行状態を、どちらもローカルで代替できる形にしておく。

## Acceptance criteria

- [ ] ローカル実装（node:sqlite / ローカル env）で全テストが通る
- [ ] 出荷は Cloudflare 実装のみ。ローカルはテストと dev と明記
- [ ] D1 / DO / R2 のどれかを止めても、他が正本を取り違えない（INV-11）
- [ ] 抽象化の正当化（呼び口2つ）を decision に書く
- [ ] 撤退条件（性能・コスト・障害）と、そのとき何を戻すかを書く
- [ ] データの移行（ローカル → Cloudflare）が必要になったときの手順

## Notes

- 「戻せる」は [docs/topology.md](../../docs/topology.md) の移行コストの項が根拠。
- 抽象化が増えるので、0066 の codec と同じく、境界の型を1か所に置く。

## やらないこと

- 両方を同時に本番運用する（読み取り専用の複製は 0164）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

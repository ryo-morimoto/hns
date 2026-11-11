# 0173: D047〜D053 採用後の docs の残り

status: open
priority: batch
depends-on: 0140
touches: AGENTS.md, docs/packages.md, docs/engineering.md, docs/decisions.md, work/issues/0032-migrate-packages.md, work/issues/0035-server-package.md, work/issues/0046-test-discipline.md, work/issues/0056-workspace-temp-cleanup.md

## Goal

0140 のレビューで blocking にならなかった取りこぼしを閉じる。
D047〜D053 で前提が変わったのに、古い書き方が残っている場所だけ。

## Acceptance criteria

- [ ] `AGENTS.md` の planned / target graph に `machine` を足す（永続化の文は 0150 で「制御データは D1、実行中の状態は DO、ローカルも D1」に更新済み）
- [ ] 0032 を「D029 の 6 パッケージの移植。`machine` は 0147」と明記
- [ ] 古い issue の `../docs` リンクを `../../docs` に（0035 / 0046 / 0056 / 0170）
- [ ] `docs/engineering.md` のテスト層に integration を足す（D051 / 0170 と整合）
- [ ] `docs/packages.md` の server 依存「全部」を明示列挙（machine と web を含むか決める）
- [ ] `docs/engineering.md` の「workspace は pi-durable にだけ依存する」を packages.md に合わせる（core, pi-durable/env）
- [ ] D052 から D047 / D049 への相互参照と、TCP sockets の出典を足す

## Notes

- 0140 の独立レビュー（docs-reviewer / PASS）の残件。blocking ではない。
- D026 / D038 の履歴（Node 24・Fastify）は append-only として直さない。
- 並行作業（D050 / D051、0170–0172）のファイルを触らない。AGENTS.md は 0140 の後に並行で変わっているので、着手時に最新を見る。

## やらないこと

- D047〜D053 の本文の書き換え（append-only。訂正は新しい決定）。
- Cloudflare 上の構成の変更。

## Log

- 2026-11-07: 作成（0140 のレビュー残件）。
- 2026-11-11: 永続化の文は 0150 の D1 専用化で更新済み。残りは machine の追記。

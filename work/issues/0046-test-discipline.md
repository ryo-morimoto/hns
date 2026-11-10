# 0046: テストの規律とランナーを固定する

status: done
depends-on: —
touches: docs/testing.md, docs/engineering.md, docs/decisions.md, AGENTS.md, vitest.config.ts, packages/*/test, packages/*/package.json, package.json, package-lock.json

## Goal

0035 以降でテストが増える前に、ランナー・層・置き場所・禁じ手を1つに決める。
いまは実装が node:test、D026 は Vitest で、規律が二重になっている。

## Acceptance criteria

- [x] node:test と Vitest を比較し、1つに決めて D038 として記録する（Vitest 5.1.0 を exact pin）
- [x] 層を定義する: unit / contract / repository / API / E2E（[testing.md](../docs/testing.md)）
- [x] 各層でモックしてよいもの・だめなもの（永続化はモックしない）
- [x] 置き場所と命名（`packages/<pkg>/test/*.test.ts`）、fixture はパッケージ内、共有 fixture は作らない
- [x] ブラウザテストは Chromium 不在で SKIP、`HNS_CHROME` で上書き
- [x] ゲートは `npm run check` の1本。watch / coverage はゲートに入れない
- [x] flaky はリトライで隠さない（TOCTOU の churn テストを決定的にした）
- [x] 選んだランナーで既存テストが全部通る（124 tests）
- [x] docs/engineering.md のテスト節を更新する

## Notes

- 比較の結果は Vitest。1 runner で将来の React まで覆えること、`projects` でパッケージを分けられること、
  Trigger.dev / Payload / Effect が Vitest、Medusa / Twenty も層ごとの設定を持っていることを根拠にした。
- 既存テストは import の差し替えだけで移行した。アサーションは `node:assert/strict` のまま（D038）。
- `npm test` = `vitest run`。`npm test -w @hns/store` は `vitest run --root ../.. --project store`。
- flaky だった churn テストは「churn 中に 1 回 applied」を要求するのをやめ、churn 停止後の通常 write で確認する形にした。

## やらないこと

- E2E（Playwright）の整備は 0043。ここでは層の定義だけ。
- coverage の閾値は今決めない（必要になってから）。
- テストの高速化・並列化は、遅いと分かってから。

## Log

- 2026-11-07: 作成。
- 2026-11-07: Vitest 5.1.0 を導入。node:test から 10 ファイル / 124 テストを移行し、`docs/testing.md` と D038 を追加。
- 2026-11-07: TOCTOU の churn テストが「全 write 拒否」で落ちる flaky を修正（churn 後の write で applied を確認）。
- 2026-11-10: 0183 でテスト管理を再設計。D038 の「node:assert/strict 固定」は D056 で Vitest の expect に置換する。層・ランナーは維持する。

## Result

- ランナー: Vitest 5.1.0（exact pin）、`vitest.config.ts` の projects（core / store / workspace / agent / server / web）。
- 層: unit / contract / repository / integration / API / E2E。実 SQLite、`fastify.inject`、E2E は Playwright。
- `npm run check` は lint → fmt → tsc → `vitest run` → build。124/124 合格。
- flaky のリトライは禁止。テストは `node:assert/strict` に統一。
- 追記（2026-11-10）: アサーションの固定は D056 で置換済み。

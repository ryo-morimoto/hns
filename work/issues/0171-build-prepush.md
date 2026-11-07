# 0171: build を pre-push に移す

status: open
depends-on: 0170
touches: .githooks/pre-push, tools/gate/stages.ts, tools/gate/main.ts, package.json, AGENTS.md, docs/engineering.md

## Goal

build をコミット前から外し、push 前に回す。実測で build は 5.5 秒（全体の 27%）。
型検査（tsrs）と重複する部分が大きく、コミットのたびに払う理由が薄い。

## Acceptance criteria

- [ ] `.githooks/pre-push` を追加し、build と knip を回す（`core.hooksPath` 配下なので clone 時に有効）
- [ ] pre-commit の段階表から build を外す（`npm run gate build` では引き続き実行できる）
- [ ] `npm run check` は build を含む全段階のまま（CI と手動の全量）
- [ ] build が型検査より多く捕まえるもの（declaration emit・`exports`/`files` と dist の一致・vite の bundle）が、
      push 前に必ず走ることをテストか手順で示す
- [ ] 実測: 全パッケージ変更時の pre-commit が 20.5 秒 → 約 15 秒

## Notes

- build を消すのではなく、段階を下げる。検出機会は残す。
- pre-push は push のたびに走るので、遅い層（0170）と合わせて「コミットは速く、push で全部」の形にする。
- `git push --no-verify` の逃げ道は残る。CI（0041）が最終ゲートになるまでは、push 前が最後の砦であることを docs に書く。

## やらないこと

- build のキャッシュ（turbo 等）は入れない。まず段階を下げる。
- CI の構築は 0041。

## Log

- 2026-11-07: 作成。

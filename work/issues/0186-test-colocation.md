# 0186: テストをコロケートし、テスト/コードから issue 参照を削除する

status: open
priority: plan
depends-on: 0184, 0185
touches: packages/*/src/**, packages/*/test/**, packages/*/tsconfig.json, packages/*/tsconfig.build.json, vitest.config.ts, package.json, AGENTS.md, docs/testing.md

## Goal

unit テストを src/<module>.test.ts にコロケートし、integration / E2E は別ディレクトリに残す。
テストとコードから issue 番号の参照を削除する。

## Acceptance criteria

- [ ] unit テストを packages/<pkg>/src/**/*.test.ts に移す（feature / module 単位）
- [ ] tsconfig.build.json で src/**/*.test.ts と test/** を除外する
- [ ] vitest.config.ts の include を src のテストに合わせる
- [ ] knip の entry を更新する
- [ ] テスト / コードの issue 参照（#0037、(0101)、(0102)、(0106)）を削除する
- [ ] TODO(#1234) を issue 番号なしの TODO: に変更し、AGENTS.md の規則を更新する
- [ ] npm run check が通る

## Notes

- 現在の参照は数件。@ts-expect-error(#0037) は理由だけ残す。
- packages/store/test/store.test.ts（473行）、core/test/http.test.ts（452行）は機能単位に分割する。
- fixture は test/support/ に残す（ビルド除外）。
- native の in-source テストは 0187。ここではコロケーションした別ファイルまで。

## やらないこと

- 振る舞いの変更
- TSDoc / doctest の追加（0187）
- E2E（0043）

## Log

- 2026-11-10: 作成（user）。コロケーションを採用し、issue 参照はコードから外す。

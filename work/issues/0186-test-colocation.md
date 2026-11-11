# 0186: テストをコロケートし、テスト/コードから issue 参照を削除する

status: done
priority: now
depends-on: 0184, 0185
touches: packages/*/src/**, packages/*/test/**, packages/*/tsconfig.json, packages/*/tsconfig.build.json, vitest.config.ts, package.json, AGENTS.md, docs/testing.md

## Goal

unit テストを src/<module>.test.ts にコロケートし、integration / E2E は別ディレクトリに残す。
テストとコードから issue 番号の参照を削除する。

## Acceptance criteria

- [x] unit テストを packages/<pkg>/src/**/*.test.ts に移す（feature / module 単位）
- [x] tsconfig.build.json で src/**/*.test.ts と test/** を除外する
- [x] vitest.config.ts の include を src のテストに合わせる
- [x] knip の entry を更新する
- [x] テスト / コードの issue 参照（#0037、(0101)、(0102)、(0106)）を削除する
- [x] TODO(#1234) を issue 番号なしの TODO: に変更し、AGENTS.md の規則を更新する
- [x] npm run check が通る

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
- 2026-11-11: unit テストを `src/**/*.test.ts(x)` に移動。core 4、store 3、agent 2、web 8。workspace は integration のみ。
- 2026-11-11: `vitest.config.ts` の unit include を src に変更。`tsconfig.build.json` に test 除外、knip の entry を src に更新。
- 2026-11-11: source/test の issue 参照を削除（schema / Gallery / Dialog / Toast / Menu / theme / setup）。codecs の自己スキャンは test ファイルを除外。
- 2026-11-11: `npm test` 175 passed、`npm run check` 成功。
- 2026-11-11: reviewer-0186 が初回 **FAIL**（blocking 2: docs/testing の古い配置記述、web の 0102/0106/0103/0115 参照）。docs と参照を修正し、再レビューで **PASS**。
- 2026-11-11: `store/src/store.test.ts`（466行）を `projects` / `conversations` / `events` / `workflows` / `automations` / `usage` / `store` と `test/support.ts` に分割。store 46 tests（689f4c1）。

## Result

- verdict: **PASS**（初回 FAIL（blocking 2）→ 修正 → 再レビュー PASS）
- reviewer: reviewer-0186
- HEAD: 66fc2ea + 0186 の未コミット変更
- blocking（初回、解消）: docs/testing.md の古い `test/` 前提、web の issue 番号参照
- 解消（2026-11-11）: `store/src/store.test.ts` を機能単位に分割（store 46 tests、689f4c1）。
- 未確認: `npm run gate pre-push`（`npm run check` で同等の全 stage を実行）。
- 変更は 0186 本体 `aa90c3c` と 0187 の docs commit `b883f3f` に含めてコミット済み。

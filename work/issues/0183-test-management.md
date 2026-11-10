# 0183: テスト管理を TSDoc 契約・コロケーション・doctest に再設計する

status: done
priority: now
depends-on: —
touches: docs/testing.md, docs/engineering.md, docs/decisions.md, docs/review/common.md, AGENTS.md, work/README.md, vitest.config.ts, package.json, package-lock.json, packages/core/package.json, packages/core/tsconfig.json, packages/core/tsdown.config.ts, packages/core/src/codecs.ts

## Goal

テスト要件定義・設計・コードの管理を、中央カタログや docs の検証表ではなく、TSDoc の契約 + コロケート/インソーステスト + doctest に寄せる。
tsdown と doctest の実行基盤を core で検証し、採用可否を決める。

## Acceptance criteria

- [x] docs/testing.md を、テスト分析（Example Mapping）→ テスト設計（技法・層）→ 実装（TSDoc / doctest / コロケーション / in-source）の1本に書き換える
- [x] 中央カタログと docs の検証表を作らない方針を明記する
- [x] TSDoc の範囲を「export する API + 内部の重要な関数」とし、@remarks / @throws / @example の使い方を書く
- [x] AGENTS.md / docs/engineering.md / docs/review/common.md の重複と旧規則（node:assert 固定、実 SQLite / モック禁止、skip / retries）を整理する
- [x] D056（Vitest の expect に統一）と D057（TSDoc + テスト。カタログと検証表なし）を docs/decisions.md に追記する
- [x] tsdown を packages/core でスパイクし、dist に実行可能な import.meta.vitest が残らないこと、d.ts / exports / Node 26 互換を確認する
- [x] vite-plugin-doctest（または代替）を core の1関数で動かし、本番ビルドに影響しないことを確認する
- [x] スパイク結果を Log に記録し、採用 / 代替を決める
- [x] npm run check が通る

## Notes

- アサーションの実移行は 0184、tiers 廃止は 0185、コロケーションと issue 参照削除は 0186、TSDoc / doctest の全体展開は 0187。
- tsdown は Rolldown ベース。unbundle で DCE が効かない場合は bundle / minify / 小さな strip plugin を比較する。
- doctest はコメントなので本番ビルドに入らない。native の if (import.meta.vitest) は tsdown の define で落とす。
- vite-plugin-doctest の制約（static import 不可、hook 不可、型検査不可）を docs に書く。
- 既存の node:assert は 0184 まで残す。この issue では変えない。
- `vitest.config.ts` と root の `package.json` は 0178 / 0180 と重なる。0183 を先にマージし、後続が rebase する。

## やらないこと

- 既存テストの書き換え（0184）
- tiers の削除（0185）
- テストファイルの移動（0186）
- 全パッケージの TSDoc / doctest 展開（0187）
- 中央カタログ / docs 検証表の作成

## Log

- 2026-11-10: 作成（user）。テスト要件定義・設計は採用、カタログと docs 検証は不採用、tsdown / Vitest / TSDoc / doctest の4点を決定。
- 2026-11-10: docs/testing.md を書き換え。AGENTS / engineering / review/common / work/README を更新。D056（expect）と D057（TSDoc + テスト）を追記。
- 2026-11-10: tsdown 0.23.7 を core に導入。build は約1秒、dist に実行可能な in-source テストなし。Node 26 で `@hns/core` と `@hns/core/graphql` を import できる。d.ts / exports / source map を確認。
- 2026-11-10: vite-plugin-doctest 3.0.0 を導入。`packages/core/src/codecs.ts` の @example が core unit で1件実行。dist には TSDoc コメントだけが残り、テストコードは入らない。
- 2026-11-10: `npm run check` 成功（271 passed / 1 skipped）。独立 review 待ち。
- 2026-11-10: reviewer-0183 が **PASS**（blocking なし）。low 3件（AGENTS の declaration emit、D056 の層の表現、testing.md の tiers 表現）を修正し、`npm run check` を再実行して成功。

## Result

- verdict: **PASS**（reviewer-0183。low 3件は修正済み）
- reviewer: reviewer-0183
- HEAD: 3c09f8a + 0183 の未コミット変更
- blocking findings: なし
- 変更は未コミット（コミットはユーザーの指示で行う）。


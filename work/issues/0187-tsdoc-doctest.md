# 0187: TSDoc 契約と doctest を全パッケージへ展開する

status: open
priority: plan
depends-on: 0186
touches: packages/*/src/**, packages/*/tsconfig.json, packages/*/package.json, packages/*/tsdown.config.ts, vitest.config.ts, package.json, package-lock.json, docs/testing.md, docs/api/, AGENTS.md

## Goal

export する API と内部の重要な関数に TSDoc 契約を書き、@example を doctest として実行する。
TSDoc を API ドキュメントの正本にする。

## Acceptance criteria

- [ ] export する API に TSDoc（@remarks / @param / @returns / @throws / @example）を付ける
- [ ] 内部の重要な関数（不変条件・並行・認可・migration・状態遷移）にも TSDoc を付ける
- [ ] @example を vite-plugin-doctest で実行する（core / store / workspace / agent）
- [ ] native の if (import.meta.vitest) を、セットアップが要らない内部関数に使う（ビルドで落ちることを確認）
- [ ] store / workspace / agent の build を tsdown に移し、本番ビルドに doctest / in-source のコードが残らないことを検査する
- [ ] TypeDoc で API ドキュメントを生成できるようにする（npm run docs:api、ゲート外）
- [ ] npm run check が通る

## Notes

- doctest は小さな例だけ。セットアップが要るものはコロケートテストへ。
- @example の制約（static import 不可、hook 不可、型検査不可）を守る。
- 内部関数は @internal を付け、TypeDoc から除外する。
- まず高リスク領域（workspace の版・journal、store の migration、auth）から。

## やらないこと

- 全関数への機械的な TSDoc 付与
- 中央カタログ / docs 検証表
- E2E（0043）

## Log

- 2026-11-10: 作成（user）。TSDoc は export API + 重要な内部関数、doctest は最初から入れる。

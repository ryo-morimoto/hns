# 0033: workspace パッケージ（移植）

status: done
depends-on: 0031
touches: packages/workspace

## Goal

Workspace を packages/workspace に移し、PoC と同じ封じ込め・競合・クラッシュ復旧を TypeScript で保証する。

## Acceptance criteria

- [x] work/poc/workspace-core の Workspace と sandbox を移植する
- [x] 契約テスト（40 チェック）を packages/workspace/test に移す
- [x] sandbox は `./sandbox` サブパスで公開する
- [x] bubblewrap が無い環境でも import できる

## Log

- 2026-11-07: 作成。
- 2026-11-07: `packages/workspace` を作り、`Workspace`・dirfd の helper・sandbox を TypeScript strict に移植した。
  PoC の 40 チェックを `test/workspace.test.ts`（23 ケース）へ、0005 の 32 チェックを `test/toctou.test.ts`（14 ケース）へ、
  sandbox の 18 チェックを `test/sandbox.test.ts`（8 ケース）へ分けた。

## Result

- `Workspace.open({ env, root, journalPath, context })` が canonical root を固定し、Journal を valibot で parse して開く。
  壊れた Journal は空として読まずに throw する（PoC は素通しだった）。
- `write` は intent → temp + flush → 再ハッシュ → dirfd の commit → outcome の順。dirfd が使えない環境は従来の再確認に落ちる（`Workspace.mode`）。
- `./sandbox` は `detectSandbox()`（bwrap の所在・版・user namespace・shell を順に確かめ、失敗 code を返す）、
  `createSandboxEnv`、`createNoExecEnv` を出す。bwrap が無くても import は副作用なしで通る。
- 依存: `@earendil-works/pi-durable`（env）、`@earendil-works/chord`（`Context` 型）、`@hns/core`（公開 DTO の型のみ）、
  `valibot`（Journal と helper の protocol）。テストは `@earendil-works/pi-env` の daemon も回す。
- 試験: `test/workspace.test.ts` 23、`test/toctou.test.ts` 14、`test/sandbox.test.ts` 8。**45 ケース**（Node env と pi-env daemon、bwrap 0.12.0）。
- `npm run build` の `dist` でも dirfd 経路が動く（`dist/rooted-helper.js` を `import.meta.url` から解決）。

## 残り

- dirfd 経路の 1 操作 1 プロセス（起動コスト）は 0005 の残りのまま。常駐化は別 issue。
- 8 MiB 超の読み取り、Journal の原子化、ディレクトリ fsync は PoC から据え置き（docs/workspace.md の限界）。
- 0034（agent）がこのパッケージの最初の利用者。

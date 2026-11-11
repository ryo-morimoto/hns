# 0187: TSDoc 契約と doctest を全パッケージへ展開する

status: done
priority: plan
depends-on: 0186
touches: packages/*/src/**, packages/*/tsconfig.json, packages/*/package.json, packages/*/tsdown.config.ts, packages/*/typedoc.json, tools/gate/dist-check.ts, tools/gate/test/dist-check.test.ts, typedoc.json, vitest.config.ts, package.json, package-lock.json, .gitignore, docs/testing.md, docs/engineering.md, docs/api/, AGENTS.md

## Goal

export する API と内部の重要な関数に TSDoc 契約を書き、@example を doctest として実行する。
TSDoc を API ドキュメントの正本にする。

## Acceptance criteria

- [x] export する API に TSDoc（@remarks / @param / @returns / @throws / @example）を付ける
- [x] 内部の重要な関数（不変条件・並行・認可・migration・状態遷移）にも TSDoc を付ける
- [x] @example を vite-plugin-doctest で実行する（core / store / workspace / agent）
- [x] native の if (import.meta.vitest) を、セットアップが要らない内部関数に使う（ビルドで落ちることを確認）
- [x] store / workspace / agent の build を tsdown に移し、本番ビルドに doctest / in-source のコードが残らないことを検査する
- [x] TypeDoc で API ドキュメントを生成できるようにする（npm run docs:api、ゲート外）
- [x] npm run check が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | public export に契約 TSDoc がある → TypeDoc を生成する → public API が出て `@internal` は出ない | 中 | 受入1, 2, 6 |
| C2 | 各 package の `@example` を実行する → 例が誤りなら unit が落ちる | 高 | 受入3 |
| C3 | in-source test を書く → 本番 build する → dist に test コードが残らない | 高 | 受入4, 5 |
| C4 | store / workspace / agent を tsdown で build する → 既存の `dist/index.js` / `dist/sandbox.js` / `dist/rooted-helper.js` が残り import できる | 高 | 受入5 |
| C5 | 全変更後にゲートを回す → lint / fmt / typecheck / test / build / knip が通る | 高 | 受入7 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 契約レビュー | static | `npm run docs:api`、`@internal` の grep |
| T2 | C2 | 例示 | unit | core workflow / store parseProject / workspace parseVersion / agent readKey・failureOf の doctest |
| T3 | C3 | 故障注入 | unit | `tools/gate/test/dist-check.test.ts`（コメントのみ / guard 残存 / body 残存） |
| T4 | C3, C4 | ビルド | build | 全 package の build + dist-check、clean build 後の import smoke、rooted-helper.js の存在 |
| T5 | C5 | ゲート | gate | `npm run check` |

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
- 2026-11-11: 実装開始。対象は core / store / workspace / agent。web は private UI で公開契約を持たないため対象外。auth package は未実装なので、鍵の読み取り（agent/keys.ts）を認可・秘密の高リスクとして扱う。
- 2026-11-11: TypeDoc 0.28.20 を exact pin。`docs/api/` は `npm run docs:api` の生成物でコミットしない（ゲート外）。
- 2026-11-11: tsdown の `define` で in-source を落とし、`tools/gate/dist-check.ts` が dist の JS を AST で検査する。workspace の `rooted-helper.ts` は runtime が path で起動するため tsdown の entry に含める。
- 2026-11-11: 4 package の export 228 件すべてに TSDoc を付与。doctest 8 件（core 4 / store 1 / workspace 1 / agent 2）と in-source 4 件を追加。`npm test` は 37 files / 193 tests。
- 2026-11-11: store / workspace / agent の build を tsdown に移行し、4 package の build で `dist-check` を実行。workspace の `dist/rooted-helper.js` と `dist/sandbox.js` を確認。built entry の import smoke と `rooted-helper.js` の probe/hash/commit を確認。
- 2026-11-11: `npm run check` exit 0（lint / fmt / typecheck / test / build / knip）。`npm run docs:api` は 0 errors / 9 warnings（内部型参照と remote 無しの source link）。
- 2026-11-11: reviewer-0187 が初回 **FAIL**（blocking 1: `AutomationActionSchema` の「present の input / conversationId は非空」が実装より強い）。文言を修正し、低指摘（workflow graph は shape のみ、sandbox の /tmp、journal 読み取り失敗、protocol、AuditEntry、dist-check の検出範囲、TypeScript の root pin、TypeDoc warning）も修正。再レビューで **PASS**。
- 2026-11-11: 0187 を 7 commit に分けてローカル commit（core / store / agent / workspace の TSDoc、tsdown、TypeDoc、記録）。push はしていない。

## Result

- verdict: **PASS**（初回 FAIL（blocking 1）→ 修正 → 再レビュー PASS）
- reviewer: reviewer-0187
- HEAD: `be0fbb1..HEAD` の 0187 commit 7 本（0186 の review 修正を含む）
- blocking（初回、解消）: `packages/store/src/schemas.ts` の `AutomationActionSchema` が `input` / `conversationId` の空文字を拒否すると読めた。実装は `title` だけ非空を要求する。
- 低（修正済み）: workflow repository の DAG 検証の誤解、sandbox の /tmp の絶対表現、journal 読み取り失敗の fail-open 記述、protocol の path / marker の記述、AuditEntry の対象、dist-check の検出漏れ（it / describe / qualified call）、TypeScript の root pin、TypeDoc warning の方針。
- 低（残り、blocking でない）: dist-check は destructure alias（`const { test: check } = undefined`）を検出しない。TypeDoc は 9 warnings（内部型参照・remote 無し）。
- 未確認: clean clone / clean node_modules からのゲート、built `rooted-helper.js` を ExecutionEnv（bwrap）経由で起動する経路、docs/api のブラウザ目視。
- ローカル commit 7 本（core / store / agent / workspace の TSDoc、tsdown、TypeDoc、記録）。push はしていない。

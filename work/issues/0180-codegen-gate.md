# 0180: relay-compiler をゲートに組み込む

status: in-progress
priority: now
depends-on: 0175, 0178
touches: tools/gate/, tools/codegen/, package.json, relay.config.json, .githooks/, docs/decisions.md, work/issues/0180-codegen-gate.md, work/BOARD.md, work/LANES.md

## Goal

GraphQL の生成物を、git と CI とローカルのどれでも同じ状態にする。stale な artifact で型検査やテストが
通ってしまう状態を無くす。

## Acceptance criteria

- [x] `npm run check` の typecheck の前に codegen が走る（または stale を検出して落とす）
- [x] staged パッケージ選択（`tools/gate/select.ts`）と整合する（core か web を触ったら走る）
- [x] 生成物が手編集されていないことを検査する（ヘッダの generated と再生成コマンド）
- [x] 生成に時間がかからないことを確認する（実測 42ms / 7 document）
- [x] `npm run gate` と `npm run gate pre-push` の両方で通る
- [x] `npm run check` が通る

## Notes

- D050 / D051 の層（commit は速い層、push は全部）に合わせる
- 生成物はコミットする（AGENTS.md: 生成ファイルは手で編集しない）
- schema は 0175 の SDL から書く（web が schema を手で持たない）
- 0183 が root の `package.json` を先に触るため、0180 は 0183 の後に rebase する。

## Design: reference-level

- `tools/gate/stages.ts` に `codegen` stage を追加（pre-commit / pre-push、lint・fmt の後、typecheck の前）。affected に `web` / `core` / `server` が無ければ何もしない。
- 3 つの run: schema 生成（`node --conditions=source tools/codegen/graphql.ts`）、`relay-compiler`、`node tools/codegen/verify.ts`。
- `tools/codegen/check.ts` の `checkGenerated` が純粋な検査。`verify.ts` が実ファイルを読んで非 0 で終わる。テストは `check.test.ts`。
- `git diff` は使わない（ローカルの未コミット生成物を drift と誤認する）。ゲートは毎回再生成するので stale は先へ進まない。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | web を触った commit → gate → codegen が typecheck より前に走る | 高 | 受入1・2 |
| C2 | store だけを触った commit → gate → codegen は走らない | 中 | 受入2 |
| C3 | artifact のヘッダ欠落 / 空ディレクトリ / schema のコマンド欠落 → verify が非 0 | 高 | 受入3 |
| C4 | 正しい生成物 → verify が 0 | 中 | 受入3 |
| C5 | codegen の所要時間が commit ゲートに収まる | 低 | 受入4 |
| C6 | npm run check と pre-push の両方で通る | 高 | 受入5 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C2 | 分岐 | unit | tools/gate/test/stages.test.ts |
| T2 | C3–C4 | 同値分割 | unit | tools/codegen/check.test.ts |
| T3 | C5–C6 | ゲート | static | npm run check / gate pre-push |

## やらないこと

- 生成物をコミットしない運用（ビルド時に生成するだけ）

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-17: 実装。`codegen` stage（source 生成 → relay-compiler → ヘッダ検証）、`tools/codegen/check.ts` と `verify.ts`、staged 選択（web / core / server のときだけ）、D075。実測 228ms、tools 37 tests 通過。

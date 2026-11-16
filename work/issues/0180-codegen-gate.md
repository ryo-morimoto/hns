# 0180: relay-compiler をゲートに組み込む

status: done
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
- [x] 生成に時間がかからないことを確認する（実測 約0.3 秒 / 2 document。commit ゲートに収まる）
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
| C2 | record だけを触った commit → gate → codegen は走らない（store / agent / workspace は server 経由で dependent に入るため走る） | 中 | 受入2 |
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

## Result

- verdict: **PASS**（blocking 0、低 7）
- reviewer: review-0180（この変更を書いていない別エージェント）。判定時 HEAD 1ed5c8f。
- 受入: 6/6。`npm run check` は 24 秒で ok（codegen 0.3 秒が typecheck の前）。`gate pre-push` も同じ。commit 層の prek 実行で codegen が走り、stale な artifact は prek の「hook がファイルを変更した」で止まる。
- 低の反映: `relay.config.json` を root trigger に、SDL ヘッダ文字列を生成器から共有（verify は source 条件で実行）、skip のテストを record（server の依存閉包に入らない）に、prek の変更検出と relay-compiler の `git add` を D075 に記録、実測値を更新。
- 残件（低）: stage のコマンド列と `npm run codegen` が二重管理（verify の有無だけ違う）。verify のヘッダ検査は codegen 直後では空振りで、実際の stale 検出は pre-commit の prek が担う（D075 に明記）。document 削除で残る orphan artifact は未検出。
- 記録: [work/records/0180.yaml](../records/0180.yaml)（verified）。

## やらないこと

- 生成物をコミットしない運用（ビルド時に生成するだけ）

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-17: 実装。`codegen` stage（source 生成 → relay-compiler → ヘッダ検証）、`tools/codegen/check.ts` と `verify.ts`、staged 選択（web / core / server のときだけ）、D075。実測 225ms、tools 37 tests 通過。
- 2026-11-17: 独立レビュー PASS（blocking 0、低 7）。低を反映: `relay.config.json` を root trigger に、SDL ヘッダの文字列を生成器から共有、skip のテストを record に、prek の変更検出と relay-compiler の `git add` を D075 に記録、`@hns/server/graphql` の vitest alias。
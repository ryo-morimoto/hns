# 0180: relay-compiler をゲートに組み込む

status: open
priority: now
depends-on: 0175, 0178
touches: tools/gate/, package.json, relay.config.json, .githooks/, docs/decisions.md

## Goal

GraphQL の生成物を、git と CI とローカルのどれでも同じ状態にする。stale な artifact で型検査やテストが
通ってしまう状態を無くす。

## Acceptance criteria

- [ ] `npm run check` の typecheck の前に codegen が走る（または stale を検出して落とす）
- [ ] staged パッケージ選択（`tools/gate/select.ts`）と整合する（core か web を触ったら走る）
- [ ] 生成物が手編集されていないことを検査する（ヘッダの generated と再生成コマンド）
- [ ] 生成に時間がかからないことを確認する（実測 42ms / 7 document）
- [ ] `npm run gate` と `npm run gate pre-push` の両方で通る
- [ ] `npm run check` が通る

## Notes

- D050 / D051 の層（commit は速い層、push は全部）に合わせる
- 生成物はコミットする（AGENTS.md: 生成ファイルは手で編集しない）
- schema は 0175 の SDL から書く（web が schema を手で持たない）
- 0183 が root の `package.json` を先に触るため、0180 は 0183 の後に rebase する。

## やらないこと

- 生成物をコミットしない運用（ビルド時に生成するだけ）

## Log

- 2026-11-10: 作成（user。D055）。

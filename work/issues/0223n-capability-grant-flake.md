# 0223n: capability の grant テストが並列負荷で落ちる（0220 の flake）

status: open
priority: next
design: agreed
design-ref: 0220 の契約
depends-on: -
touches: packages/core/src/capability/grant.test.ts

## Goal

`packages/core/src/capability/grant.test.ts:202`（「a signature that does not verify is grant_invalid」）が、**並列負荷（npm run check の中）で 1/2〜1/4 落ちる**。単独実行では 3+/3 pass。0221 は `packages/core` を 1 バイトも変えていないので、0220 の契約・テストの flake。**main の gate が不安定になるため、0221 の統合前に切り出す。**

## Acceptance

- [ ] 失敗の再現条件を特定する（同時実行数、乱数、鍵生成の失敗など）
- [ ] 決定的なテストにする（固定鍵 / 固定署名 / 待ち時間に依存しない）
- [ ] `npm run check` を 3 回連続で緑

## Log

- 2026-11-18: 0221 のレビューで発見（reviewer-0221 の 4 回中 1 回、full check の 3 回中 2 回）。

# 0179: サイドバーを Relay で読む（最初の 1 画面）

status: open
priority: now
depends-on: 0178, 0102
touches: packages/web/src/app/Sidebar.tsx, packages/web/src/app/Shell.tsx, packages/web/src/app/fixtureSummaries.ts, packages/web/test/app/

## Goal

既存のサイドバー（0102）を Relay の fragment に置き換え、最初の画面を通す。
0115 の overview は hold のままなので、まず既存の会話一覧で通す。

## Acceptance criteria

- [ ] サイドバーが Relay の fragment で conversations を読む（component が選択を持つ）
- [ ] 同じ画面を 2 回開くと network 0 回（テストで固定）
- [ ] 初回の DO RPC がワークスペース数以下（テストで数える）
- [ ] 索引が遅れたときの「更新中」表示を後から足せる形にする（0149）
- [ ] 既存の Shell テストが通る
- [ ] `npm run check` が通る

## Notes

- 実測: 再訪 network 0、初回 12 RPC（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §14）
- 鮮度: この時点では network-only で明示的に取り直す。方針は 0181
- 0115 の overview は 0149 の後に別 issue で通す

## やらないこと

- overview（0115）
- ライブ更新（0159）

## Log

- 2026-11-10: 作成（user。D055）。

# 0033: workspace パッケージ（移植）

status: open
depends-on: 0031
touches: packages/workspace

## Goal

Workspace を packages/workspace に移し、PoC と同じ封じ込め・競合・クラッシュ復旧を TypeScript で保証する。

## Acceptance criteria

- [ ] work/poc/workspace-core の Workspace と sandbox を移植する
- [ ] 契約テスト（40 チェック）を packages/workspace/test に移す
- [ ] sandbox は `./sandbox` サブパスで公開する
- [ ] bubblewrap が無い環境でも import できる

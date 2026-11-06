# 0001: T-02 の残り

status: open
depends-on: -
touches: poc/root-containment, docs/design

## Goal

Root 封じ込めを「読める/拒否できる」から「監査できて、Worker 越しでも同じ」にする。
traversal と symlink 脱出は 7/7 で拒否済み（`poc/root-containment`）。

## Acceptance criteria

- [ ] 拒否が `operationId` 付きで監査ログに残る
- [ ] Root を rename / 差し替えした最中の read/write の挙動を記録
- [ ] `RemoteExecutionEnv` 越しでも同じ 7 ケースが通る
- [ ] TOCTOU の残余を契約 `認可` に追記

## Log

- 2026-11-06: 作成。

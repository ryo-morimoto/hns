# 0003: Workspace Walking Skeleton

status: open
depends-on: 0002
touches: poc/, docs/design

## Goal

`WorkspaceFileApi` の read / write / watch を、最小の Worker 上で端から端まで通す。
会話・モデル・UI はまだ作らない。

## Acceptance criteria

- [ ] 1マシンで read → 編集 → `expectedVersion` 付き write が通る
- [ ] `watch` の `seq` から再接続し、最終状態と一致する
- [ ] `overflow` で全再読込できる
- [ ] 起動手順を README に追記

## Log

- 2026-11-06: 作成。

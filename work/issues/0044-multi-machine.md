# 0044: マルチマシン（保留）

status: open
priority: parked
design: pending
depends-on: 0040
touches: packages/worker, packages/server

## Goal

2台目以降のマシンを UI から操作できるようにする。

## Acceptance criteria

- [ ] マシン側の常駐 worker
- [ ] RemoteExecutionEnv 越しの Workspace / exec
- [ ] 接続認証・切断時の再開・複数 root
- [ ] 1マシン完成後に着手する

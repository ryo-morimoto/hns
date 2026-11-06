# 0003: Workspace Walking Skeleton

status: done
depends-on: 0002
touches: work/poc/, docs/design

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
- 2026-11-06: `work/poc/walking-skeleton` を実装。12/12 合格。

## Result

- client → Worker（HTTP）→ LocalExecutionEnv（pi-env daemon）→ files が通る。
- `/write` は expectedVersion を要求し、競合は 409、unknown は 202。
- `/events?cursor=N&limit=M` は Journal の seq から再生し、再接続で欠落を埋める。
- 外部変更（bash 相当）を `changed`、`overflow` をイベントとして流す。
- 残り: UI、認証、Worker の常駐化、SSH 越しの Pi（今は daemon をパイプで使用）。
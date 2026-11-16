# 0057: journal の一時ファイル名を一意にする

後継: 0190（workspace の低負債を一括で閉じる）。

status: superseded
depends-on: 0045
touches: packages/workspace

## Goal

Journal の原子的保存は `journalPath + ".tmp"` という固定名を使う。同じ journalPath を 2 つの
Workspace が開くと、互いの temp を上書きして壊れうる。一意にするか、二重 open を検出して拒否する。

## Acceptance criteria

- [ ] temp 名に `randomUUID()` を付ける
- [ ] 同じ journalPath を二重に開いた場合の方針を決める（拒否するなら `Unavailable` で fail closed）
- [ ] 二重 open と、失敗した保存が次を壊さないことを回帰テストで固定する

## Notes

- `#save` は直列化しているので、1 プロセス内の競合は起きない。問題は別プロセス・別 Workspace。
- 排他は lock ファイルでもよいが、まず temp 名の衝突を消す。

## Log

- 2026-11-07: 作成（コードレビューで固定 `.tmp` を見つけた）。
- 2026-11-11: 0190 に吸収（superseded）。

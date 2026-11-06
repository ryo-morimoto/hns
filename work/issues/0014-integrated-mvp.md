# 0014: 統合 MVP（1マシン）

status: open
depends-on: 0003, 0008, 0012
touches: work/poc/app, docs/workspace.md

## Goal

ブラウザから会話し、Agent がファイルを編集し、diff を見て、再起動しても続きから動く。
ゲート [0002](../gates/0002-integrated-mvp.md) の範囲。

## Acceptance criteria

- [ ] Durable を SQLite に保存し、プロセス再起動で会話と未完了タスクが戻る
- [ ] UI で会話・ツール実行・ファイルの変更が同じ画面で追える
- [ ] エージェントの編集を Editor で開き、diff と競合を確認できる
- [ ] `bash` は sandbox 経由、鍵はリポジトリ外

## Log

- 2026-11-06: 作成。ゲート 0002 は未承認。

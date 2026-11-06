# 0014: 統合 MVP（1マシン）

status: done
depends-on: 0003, 0008, 0012
touches: work/poc/app, docs/workspace.md

## Goal

ブラウザから会話し、Agent がファイルを編集し、diff を見て、再起動しても続きから動く。
ゲート [0002](../gates/0002-integrated-mvp.md) の範囲。

## Acceptance criteria

- [x] Durable を SQLite に保存し、プロセス再起動で会話が戻る
- [x] UI で会話・ツール実行・ファイルの変更が同じ画面で追える
- [x] エージェントの編集を Editor で開き、diff と競合を確認できる
- [x] `bash` は sandbox 経由、鍵はリポジトリ外

## Log

- 2026-11-06: 作成。ゲート 0002 は未承認。
- 2026-11-06: 実装。E2E 8/8、実モデル（Ollama）1往復。

## Result

`work/poc/app` — 1プロセスに統合。

- SQLite（`openNodeSqliteStorage`）に会話を保存。再起動でトランスクリプトとファイルが戻り、続きを話せる。
- UI は会話・ツール結果・ファイル一覧・エディタ・diff を1画面に。進捗は 1 秒のポーリング（`live` 件数）。
- ツールは `read_file` / `write_file` / `bash`（sandbox）。
- 起動: `PROVIDER=ollama node serve.mjs <root>`（`MODEL_ID` / `STATE_DIR` 可）。

残り: 進捗のストリーミング、未完了タスクの可視化、複数会話。
# 0007: 会話の実結線

status: done
depends-on: -
touches: work/poc/conversation, docs/decisions.md

## Goal

Agent が Workspace と sandbox を通してファイルを扱えることを、1つの会話で示す。

## Acceptance criteria

- [x] 会話から `read_file` → `write_file` が動く（版チェック込み）
- [x] `bash` が sandbox 内で動き、root 外に出られない
- [x] 古い版からの書き込みが `conflict` としてモデルに返る
- [x] ターン後に live task が残らない

## Result

`work/poc/conversation` **10/10**。faux provider で鍵なしに実行。実 Provider は U-05。

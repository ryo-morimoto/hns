# 0029: 会話の管理（要件20）

status: done
depends-on: 0016
touches: work/poc/app

## Goal

会話が増えても迷わない。名前を変える、しまう、消す、探せる。

## Acceptance criteria

- [x] 一覧（更新順・Project 絞り込み）
- [x] 改名
- [x] アーカイブ（既定では隠す、`includeArchived=1` で表示）
- [x] 削除（論理削除。Durable の履歴は残す）
- [x] タイトル検索（`q`）
- [x] root 会話は削除できない
- [x] 会話の操作を journal に残す

## Result

- `PATCH /api/conversations/:id`（title / archived）、`DELETE`（論理削除）、`GET ?q=&includeArchived=`。
- 送信と完了で `updated_at` を更新。一覧は更新の新しい順。
- 削除後の `/api/state` と `/api/chat` は 404。
- テスト `run-conversations.mjs` 13/13。

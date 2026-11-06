# 0016: Project と Task

status: done
depends-on: 0014
touches: work/poc/app, docs/domain.md

## Goal

Project と Task を Control Plane の SQLite に持つ。Conversation を Project に紐付ける。
設計は [domain.md](../../docs/domain.md)。

## Acceptance criteria

- [x] Project の作成・一覧・改名
- [x] Task の作成・状態遷移（todo / doing / done / blocked）・一覧
- [x] Conversation に projectId を持たせ、Project ごとに一覧
- [x] Task と Durable の Task が混ざらない（別 ID）

## Log

- 2026-11-06: 作成。UI は最小のまま（D011）。
- 2026-11-06: 実装。15/15 合格。

## Result

- `work/poc/app/db.mjs` が Control Plane の SQLite（`control.sqlite`）を持つ。Durable の `session.sqlite` とは別。
- API: `/api/projects`（GET/POST/PATCH）、`/api/tasks`（GET/POST/PATCH）、`/api/conversations`（GET/POST）。
- 会話は複数作れる。チャットと状態は `conversationId` で切り替え。
- 再起動しても Project / Task / Conversation の対応が残る。
- UI は未対応（D011）。
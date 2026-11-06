# 0016: Project と Task

status: open
depends-on: 0014
touches: work/poc/app, docs/domain.md

## Goal

Project と Task を Control Plane の SQLite に持つ。Conversation を Project に紐付ける。
設計は [domain.md](../../docs/domain.md)。

## Acceptance criteria

- [ ] Project の作成・一覧・改名
- [ ] Task の作成・状態遷移（todo / doing / done / blocked）・一覧
- [ ] Conversation に projectId を持たせ、Project ごとに一覧
- [ ] Task と Durable の Task が混ざらない（別 ID）

## Log

- 2026-11-06: 作成。UI は最小のまま（D011）。
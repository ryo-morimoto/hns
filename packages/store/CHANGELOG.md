# Changelog

## 0.1.0

- Row types for projects, tasks, conversations, events.
- Mapping to the public model, with boundary checks.
- **Breaking:** the store runs on Cloudflare D1 only; `openStore({ path })` is replaced by
  `openStore({ d1 })`, every repository method and `close` are async, and `node:sqlite` is removed (D064).
- Migrations record their version in `schema_migrations` and apply schema and version in one atomic D1 batch.
- **Breaking:** migration 6 drops the first-generation `events` and `usage_log` tables. Their content is not
  migrated: observations live in `obs_events` (the Session Durable Object's SQLite) and per-turn usage in
  `cost_turn`, and neither table has had a writer since the object took over. The same step replaces the
  `conversations` indexes with `conversations_page` over `updated_at`.
- **Breaking:** the `events` and `usage` repositories are removed, along with `parseEvent`,
  `parseUsageToday`, and the store's `Event` / `Metrics` model. The `workflows` and `automations`
  repositories expose their reads only, and the `conversations` repository exposes `page` / `get` /
  `touch` (the Session writes rows through `@hns/store/conversation-index`).
- `ConversationIndex.read` returns a project's indexed rows, so a drain compares before it writes.
- The Journal's outcome and audit `reason` is a closed refusal vocabulary (`JOURNAL_REFUSAL_CODES`, checked
  against the core list).

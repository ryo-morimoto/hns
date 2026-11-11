# Changelog

## 0.1.0

- Row types for projects, tasks, conversations, events.
- Mapping to the public model, with boundary checks.
- **Breaking:** the store runs on Cloudflare D1 only; `openStore({ path })` is replaced by
  `openStore({ d1 })`, every repository method and `close` are async, and `node:sqlite` is removed (D064).
- Migrations record their version in `schema_migrations` and apply schema and version in one atomic D1 batch.

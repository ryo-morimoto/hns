# Changelog

## 0.1.0

- The Worker edge: GraphQL / WS / static routing, session cookie verification, correlation ids,
  and request limits.
- The Session Durable Object: pi-durable Harness on DO SQLite, multiple conversations, metadata,
  internal RPC, and alarm-driven wake/recovery.
- **Breaking:** a Session opens only when `HNS_ENV` is `dev` or the `DB` binding is present; otherwise the
  object refuses to open and answers 503 (fail closed).
- The conversation index writes its `index.*` observations into the object's `obs_events` as `ObsLogEntry`,
  after the turn's rows are measured, and drops the observation when the drain fails on D1.
- The machine client parses a refusal answer against the core refusal vocabulary and passes the code on, so a
  denied write is recorded with the code the machine answered.

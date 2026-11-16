# Changelog

## 0.1.0

- Loopback-only HTTP agent behind cloudflared: `POST /rpc` with health / stat / read / list.
- Ed25519 request signatures over a versioned message, a ±60 second clock window, and a nonce cache.
- Connection gate: the older of two connections is refused by its `seq`.
- ROOT containment: normalizes wire paths, canonicalizes the parent, refuses symbolic-link escapes,
  and opens reads with `O_NOFOLLOW`.
- Limits: concurrency, request and response bytes, and one deadline covering the body read and the operation.
- Device key loader that refuses a key readable by group or other, a symbolic link, or a non-Ed25519 key.

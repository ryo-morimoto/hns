# Changelog

## Unreleased

- The `exec` operation, available only when the sandbox probe passed at start: commands run inside bubblewrap with
  the project writable, `.git` read-only, the machine's fixed hide list masked, and the allowlisted environment.
  Without a passing probe every exec is refused with `forbidden`.
- The `checkpoint` operation: snapshots ROOT's working tree as `refs/hns/checkpoints/<runId>` and answers metadata
  only (0243's prepare answer, with the pack's size and largest blob). One Run has one commit, however often it is
  asked.
- The signed pack route `POST /rpc/checkpoint/<runId>/pack` (`application/x-git-pack`, `content-length` required,
  64 MiB): a declared length over the limit is refused before the body is read and nothing partial is kept. Packs
  and operations have separate deadlines and share the concurrency slots.

## 0.1.0

- Loopback-only HTTP agent behind cloudflared: `POST /rpc` with health / stat / read / list.
- Control-plane Ed25519 request signatures verified against the enrolled keys (several during a rotation),
  over a versioned message, a ±60 second clock window, and a nonce cache.
- Connection gate: the older of two connections is refused by its `seq`.
- ROOT containment: normalizes wire paths, canonicalizes the parent, refuses symbolic-link escapes,
  opens reads with `O_NOFOLLOW`, and refuses a symbolic link for listings too; `stat` reports one without
  following it. FIFOs, devices, and sockets are refused before they are opened.
- Limits: concurrency, request and response bytes, and one deadline covering the body read and the
  operation; the operation is awaited to settlement so its slot is not released early.
- A wrong method answers 405 and a wrong route answers 404.
- Device key loader that refuses a key readable by group or other, a symbolic link, or a non-Ed25519 key.
- The machine's device key is outbound-only (machine to Worker) and is supplied in 0148.

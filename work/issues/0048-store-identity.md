# 0048: store/identity（認証・秘密）

status: open
depends-on: 0047
touches: packages/store/src/identity, packages/store/package.json, packages/store/test, package-lock.json

## Goal

users / sessions / credentials / user_keys / secrets を store の `./identity` に移し、server が認証と秘密を組み立てられるようにする。

## Acceptance criteria

- [ ] テーブルとリポジトリ: users / sessions / credentials / user_keys / secrets
- [ ] secrets は scope（user / service）と AES-256-GCM。user は unlocked の DEK だけ
- [ ] passkey（`@simplewebauthn/server`）・recovery・tailscale の検証ロジックを TS で移植
- [ ] `@hns/store/identity` で公開する。server は SQL を書かない
- [ ] 秘密・token・本文をログに出さないテスト
- [ ] passkey のブラウザテストは Chromium 不在で SKIP

## Notes

- `package.json` / `package-lock.json` を触る。この間、他の依存追加 issue を並行させない（0051 の lock owner）。
- `@simplewebauthn/server` は exact pin。

## やらないこと

- HTTP の配線（0035）。
- PRF / DEK の UI（0036）。

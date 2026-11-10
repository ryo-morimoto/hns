# 0070: passkey の登録・ログインとセッション

status: open
priority: plan
depends-on: 0048
touches: packages/store/src/identity/passkey.ts, packages/store/test, packages/store/package.json, package-lock.json

## Goal

`@simplewebauthn/server` で登録とログインを検証し、セッションを発行する。DEK の包みと復旧コードは 0071。

## Acceptance criteria

- [ ] 登録 options / verify、ログイン options / verify を `@hns/store/identity` から使える
- [ ] challenge は login ごとに5分・一度だけ。使い捨てをテストで示す
- [ ] 登録で user を find-or-create。excludeCredentials に既存 credential を入れる
- [ ] ログイン成功でセッションを発行（30日）。未登録 credential は verified: false
- [ ] 成功時に counter を更新し、更新後の値が保存されることをテストで示す
- [ ] `@simplewebauthn/server` を exact pin（14.0.3）。lock を触るのはこの issue だけ
- [ ] verify は仮想オーセンティケータで採取した attestation / assertion の fixture で通す（Chromium 不要）
- [ ] rpID / origin の不一致は verified: false

## Notes

- fixture は `packages/store/test/fixtures` に置き、採取手順を README に書く。撮り直しは PoC の `run-passkey.mjs` を借りる
- ブラウザの仮想オーセンティケータでの E2E は 0043。store はライブラリなので Playwright を devDependency に足さない
- HTTP のルート（`/api/passkey/*`）は 0035。ここは検証と保存だけ

## やらないこと

- DEK の包み・unlock・復旧コード（0071）
- セッション cookie の発行と検証（0035）
- 利用者の UI（0036）

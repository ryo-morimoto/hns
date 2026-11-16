# 0048: store/identity（認証・秘密）

status: open
priority: next
design: agreed
design-ref: D079
depends-on: 0047
touches: packages/store/src/identity, packages/store/package.json, packages/store/test, package-lock.json

## Goal

users / sessions / credentials / user_keys / secrets を store の `./identity` に移し、server が認証と秘密を組み立てられるようにする。

## Acceptance criteria

- [ ] テーブルとリポジトリ: users / sessions / credentials / user_keys / secrets
- [ ] セッションは `sid` + `isActive`（0158 が cookie に `sid` を足す）
- [ ] secrets は暗号文・iv・tag を保存するだけ（AES-GCM は 0069、DEK の包みは 0071）
- [ ] passkey の検証は 0070。tailscale は 0158 で廃止（この issue では持たない）
- [ ] `@hns/store/identity` で公開する。server は SQL を書かない
- [ ] 秘密・token・本文をログに出さないテスト
- [ ] passkey のブラウザテストは 0070 に移す

## Notes

- 依存は足さない。`@simplewebauthn/server` は 0070 が exact pin し、lock owner も 0070。

## Design（案・レビュー中）

2026-11-17 / レビュー前の案。承認後に DNNN を追記し `design: agreed` にする。

### 前提

- 0048 の AC は passkey・recovery・tailscale の移植まで含むが、0069 / 0070 / 0071 が同じ領域を持つ。tailnet 認証は 0158 で廃止（D016）。`@simplewebauthn/server` は 0070 の依存。
- 0145 の cookie は `{v:1,sub,exp}` の署名済みで、セッション行を持たない。このままでは端末ごとの失効ができない（docs/auth.md は「端末ごとに失効できる」と書く）。
- PoC の schema: users / credentials / user_keys / sessions / secrets。DB は D1（0150）。

### 決定案 1: 0048 は「表・リポジトリ・公開面」に絞る

- **0048**: users / credentials / sessions / user_keys / secrets のテーブルとリポジトリ、`@hns/store/identity` の公開、parse。
- **0069**: secrets の暗号（AES-256-GCM）と scope の読み分け。0048 は暗号文・iv・tag を保存するだけで、鍵も平文も触らない。
- **0070**: passkey の検証と credential / session の発行、`@simplewebauthn/server` の pin。
- **0071**: DEK の包みと復旧コード。
- tailscale の移植は**やらない**（0158 で tailnet 認証を廃止）。
- 0048 では依存を足さない。`package-lock.json` を touches から外す（lock owner は 0070）。

### 決定案 2: 型は `@hns/store/identity` に置く

- D030: 型は不変条件を持つパッケージに置く。identity は保存形（暗号文・counter・0/1）と公開型の変換を持つので、store が正本。
- 公開型: `User` / `Credential` / `SessionRecord` / `UserKey` / `SecretRecord`。保存形は出さない。
- GraphQL のモデルには載せない（`me` は 0158 の応答型）。

### 決定案 3: セッションは `sid` で失効できるようにする

- `sessions(id, user_id, created_at, expires_at, revoked_at)`。ログインで行を作り、logout / 端末削除で `revoked_at` を立てる。
- 0145 の cookie payload は `sid` を持たない。**0158 で `sid` を足し、edge が `isSessionActive(sid)` を確認する**（D1 1 read。単一ユーザーなので許容。必要になったら isolate の短い cache）。
- 0048 は `create` / `get` / `revoke` / `isActive` を提供する。cookie の形式と属性は 0158。
- 0158 の当たり所: `packages/server/src/edge/session.ts` の `SessionPayloadSchema` と `readSessionCookie`。いまは `sid` を無視するので、`sid` を返し、edge が `isSessionActive` を呼ぶ形に広げる。
- 代替: 署名済み cookie だけにして端末失効を諦める（docs/auth.md の約束を落とす）。採らない。

### 決定案 4: schema

```
users(id, login UNIQUE, created_at)
credentials(id, user_id, public_key, counter, transports, created_at, last_used_at)
sessions(id, user_id, created_at, expires_at, revoked_at)
user_keys(id, user_id, kind, credential_id, wrapped_dek, iv, salt, label, created_at)
secrets(scope, name, ciphertext, iv, tag, created_at, updated_at, PRIMARY KEY(scope, name))
```

- `scope` は `user` / `service` の closed union、`kind` は `prf` / `recovery` の closed union。
- 秘密の値は保存しない（ciphertext / iv / tag だけ）。`list` は `name` と `updated_at` だけを返す。
- 単一ユーザー: `users` は1行、`secrets` は owner を持たない。マルチユーザー / RBAC は 0158 の外（U-04）。
- FK: credentials / sessions / user_keys → users ON DELETE CASCADE。secrets は FK なし。
- `counter` は 0 以上の整数、`transports` は JSON 配列。壊れた行は既定値に落とさず ValiError。

### 決定案 5: migration と公開

- 既存の D1 migration runner に identity のテーブルを足す（次の番号。0149 / 0127 の後なら 0005）。
- `@hns/store/identity` を `package.json` の exports と `tsdown.config.ts` の entry に足す。
- server は SQL を書かない。0158 / 0069 / 0070 / 0071 はこの subpath だけを使う。

### 認証方式の比較（2026-11-17）

U-01 の前提として、入口の認証を A Native（passkey）/ B Access-only（サーバ鍵）/ C Hybrid / D Tailnet で比較した: `work/research/auth-access-options.md`。tailscale は 0158 で外す記録だが、0158 は design: pending なので再判断してよい。**A を既定、C を運用オプション、D は 0040、B はサーバ鍵を許容する場合だけ**を推奨。

### 未確定

| ID | 論点 | 仮説 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 0048 の範囲を表・リポジトリに絞るか | **決定（user / D079）**: 表・リポジトリ・公開面に絞る。passkey → 0070、暗号 → 0069、包み → 0071、tailscale は削除 | 0069 / 0070 / 0071 / 0158 | 2026-11-17 |
| U-02 | 型の置き場 | **決定（user）**: `@hns/store/identity`。core には載せない | D030 / 0158 | 2026-11-17 |
| U-03 | セッションの失効 | **決定（user）**: `sid` + `isSessionActive`。0158 で cookie を拡張。D1 1 read を許容 | 0145 / 0158 | 2026-11-17 |
| U-04 | secrets の owner | **決定（user）**: 単一ユーザーのまま（PK = scope + name）。マルチユーザーは別 issue | 0069 / 0158 | 2026-11-17 |
| U-05 | migration の置き場 | **決定（user）**: 既存の D1 runner に足す（別 runner を作らない） | 0150 / 0149 / 0127 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | users を find-or-create で2回 → 1行。同じ login は同じ id | 高 | 受入1 |
| C2 | credential を追加 → counter を更新 → last_used_at が進む。重複 id は拒否 | 高 | 受入1 |
| C3 | session を作る → revoke → isActive が false。期限切れも false | 高 | 受入3 |
| C4 | user_key を追加・一覧・削除 → wrapped_dek だけが返り、DEK 平文は出ない | 高 | 受入1 |
| C5 | secret を put / get / list / delete → list は name と updated_at だけ。値は返らない | 高 | 受入2 |
| C6 | 未知の scope / kind、欠けた列 → ValiError。既定値に落ちない | 高 | 受入1 |
| C7 | 例外メッセージに秘密・token・本文が出ない | 高 | 受入5 |
| C8 | `npm run check` | 高 | 受入6 |

層は unit（parse / schema）と integration（miniflare の実 D1 で C1–C5）。0070 の仮想 authenticator / ブラウザテストは 0070 に移す。

## Log

- 2026-11-17: 設計案を追加（レビュー待ち）。
- 2026-11-17: U-02〜U-05 を決定。U-01 は認証方式の比較（work/research/auth-access-options.md）で決める。
- 2026-11-17: 認証を A Native（D079）に決定。U-01 を「表・リポジトリ・公開面」に絞り、AC と Notes を更新。`design: agreed` にした。
## やらないこと

- HTTP の配線（0035）。
- PRF / DEK の UI（0036）。

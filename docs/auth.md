# 認証: tailnet と passkey

2026-11-06 / 要件13。共有 token（0019）の限界と、次の段。

## なぜ token だけでは足りないか

- URL に載るので履歴・ログ・コピペで漏れる。端末ごとの失効ができない。
- 「誰が」が分からない。監査も権限もユーザー単位にできない。
- 通信は TLS 前提でも、アプリ側の入口は 1 本の鍵。

## tailnet の ID を使う（実装済み）

`auth: "tailscale"` にすると、接続元 IP を `tailscale whois --json` で引いて利用者を決める。

- 許可は `HNS_TAILSCALE_USERS`（カンマ区切りの LoginName）。空なら tailnet の誰でも。
- ループバックは既定で**拒否**。手元から使うなら `HNS_ALLOW_LOCAL=1`。
- whois は 1 分キャッシュ。引けなければ拒否。
- 使うときは `HOST=0.0.0.0`（または tailnet の IP）で待ち受け、tailnet の外に出さない。
  ACL で端末・ユーザーを絞れば、ネットワーク層とアプリ層の二重になる。

`tailscale serve` のヘッダ（`Tailscale-User-Login`）を信じる方式は採らない。
アプリが他経路からも届くなら詐称できるため、whois の方が安全。

## passkey（実装済み）

- 登録・ログインは WebAuthn。`@simplewebauthn/server` で challenge を発行・検証し、
  credential（id / publicKey / counter）を Control Plane に保存する。
- ログイン後はサーバ署名の HttpOnly セッション cookie。端末ごとに失効できる。
- 実装: `passkey.mjs`、`/api/passkey/*`、`ui/login.html`。`auth: "passkey"` で切り替える。
- credential は Control Plane に保存。セッションは `hns_session` の HttpOnly cookie（30日）。

## テスト手段（実装済み）

ブラウザの認証器は Playwright の**仮想オーセンティケータ**で再現する。

- `playwright-core` + Nix の Chromium（`HNS_CHROME` で上書き）。
- CDP: `WebAuthn.enable` → `WebAuthn.addVirtualAuthenticator`（ctap2 / internal / UV 済み）。
- `run-passkey.mjs` が 登録 → 未ログインで 401 → ログイン → セッションで 200 まで通す。
- `hasPrf: true` の仮想認証器で `run-prf.mjs` が PRF の包み・開き・再起動後のロックまで通す。
- Chromium が無い環境では SKIP する。

## 暗号化・復号化（実装済み）

秘密は**スコープで分ける**（実装済み）。§user§ は人のもの、§service§ は Automation 用。
§secrets.mjs§ が AES-256-GCM で保存し、§getService§ は §user§ を読めない。
Provider 鍵は §service/provider.<name>§ に置けば、ファイルや env を汚さずに使える。

### PRF で包む（実装済み）

- 登録時: 認証器の PRF 出力から HKDF で KEK を作り、ブラウザでデータ鍵（DEK）を包んで送る。サーバは包んだ DEK だけ保存する。
- ログイン時: 同じ KEK で DEK を開き、`/api/passkey/unlock` でセッションに渡す。DEK は**メモリだけ**に置く。
- 再起動やログアウトで DEK は消える。その状態で `user` の秘密を読むと `423 locked`。
- PRF 非対応の認証器では包まない。`user` は使えないが、`service` とアプリ自体は動く。
- Automation は `service` しか使わないので、誰もログインしていなくても動く。

WebAuthn には「鍵を渡す」機能が無い。使えるのは **PRF 拡張**（認証器の hmac-secret）。

- 登録時に PRF の salt を渡し、`prf.results.first` から鍵を導出 → データ鍵を包む（wrap）。
- 平文のデータ鍵は**ログイン中のメモリだけ**に置く。DB には包んだ鍵だけ。
- これで「サーバが勝手に復号できない」状態になるが、**利用者がいないと復号できない**。

### ぶつかる制約

- Automations（0018）や夜間の Workflow は、利用者がいない時間に動く。復号できないと止まる。
- 対策は 3 つ。どれも「誰が復号できるか」の選択:
  1. 包んだ鍵をサーバの鍵でも包む（二重）→ 常時動くが、PRF の意味が薄れる。
  2. サービス用の資格情報を別に持ち、ユーザーの秘密とは分ける（Automation はこちらだけ使う）。
  3. 復号が必要な操作は「利用者のログイン中だけ」と割り切る。
- 今の推奨は 2。ユーザーの秘密（Provider 鍵など）と、Automation の実行資格情報を分ける。

## 未決

| ID | 論点 | 案 |
| --- | --- | --- |
| AR-01 | passkey を第一手段にするか tailnet の補助か | tailnet があれば補助 |
| AR-02 | PRF 非対応の認証器 | その端末ではパスワード/復旧コード |
| AR-03 | 復旧 | リカバリコードを紙で保管 |
| AR-04 | セッションの寿命と失効 | 端末ごと、30 日 + 明示ログアウト |
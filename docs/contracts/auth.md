# 契約: 認証（入口・セッション・秘密）

2026-11-18 / L6 M2 の続き。**この面の契約の正本**。実装は `server/src/edge/` と `@hns/core` の codecs。背景と履歴は [auth.md](../auth.md)、不変条件は [invariants.md](../invariants.md) の INV-01。

## 入口は Worker に 1 つ

- 認証済みかどうかは **Worker（edge）が決める**。面ごとの表を二重管理しない。面は「実装する issue が認証方式を同じ変更で宣言する」（D059）。
- 入口は **A Native（passkey + PRF + デバイス鍵）**。Cloudflare Access と tailnet は既定にしない（D079）。
- 未認証の REST は `401`、`/graphql` は `401`（problem+json）、`/ws` は `401`。画面はクライアントで `/login?next=` に遷移し、同一 origin のパスだけ復帰する。

## セッション cookie（0145）

- 名前は `hns_session`。値は `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`。
- payload は `{v:1, sub, exp}`（`exp` は unix 秒）。署名の対象は payload の base64url 文字列。
- `HNS_SESSION_SECRET`（32 文字以上）で検証する。**未設定・短すぎ・期限切れ・署名不一致・`v` が 1 でない・`sub` が空・同名 cookie が複数**はすべて 401。**既定値への fallback をしない**（fail closed）。
- `Authorization: Bearer` や `?token=` をセッションの代わりに使わない。CSRF は `SameSite` + JSON + WS の `Origin` で守る（D096）。

## 署名（machine との間）

- **Worker → machine（inbound）**: control-plane の Ed25519 秘密鍵（Worker の secret）で署名し、machine は enrollment で配られた公開鍵で検証する（D100）。`x-request-id` は署名対象にしない。
- **machine → Worker**: device 鍵（マシンの 0600、公開鍵は Machine レコード）。inbound の検証には使わない。
- **machine の device 公開鍵の置き場**（0148）: `machines.public_key`（D1、32 バイトの BLOB）。秘密は machine の 0600。`GET /api/machines/keys` は control-plane の**公開鍵だけ**を返し、session を要求する（D059）。失効は `status = 'revoked'` で、registry が鍵を返さなくなる。

## capability grant の発行を要求できるのは誰か（0224）

`requestGrant`（Session DO の `POST /rpc/grants`）を呼べるのは、**session cookie を持つ人**だけである。Worker が session cookie を検証し、その subject を grant の `requestedBy` として object に渡し、object は body の `requestedBy` がこの subject（またはその subject の `agent:` 名前空間の agent）と一致すること、および Worker が session secret から導いたトークンを提示することを検査する。**project / machine の所有権の検査は未実装**なので、session を持つ人なら誰でも任意の project・任意の登録済み machine を名指しして grant を要求できる（machine の mutation と同じ状態）。grant は `requestedBy` と監査の行にこの subject で残る。所有権を認可に使うのは follow-up。

**会話への send**（`Mutation.sendMessage` → Session DO の `POST /rpc/conversations/<id>/messages`、0270n）も同じ状態である。Worker は D1 の索引から会話の行とその project を引き、**行が無い・削除済み・project が無い**を同じ `not_found` にする（存在の有無を漏らさない）が、**会話と project に owner が無い**ので、session を持つ人は**この deployment の任意の会話に送れる**。`created_by` を足したら、object を呼ぶ前の認可に使う（`src/graphql/send-message-port.ts` の TSDoc）。

## 秘密

- 鍵は `~/.config/hns/`。デプロイの秘密は Cloudflare の secret で、リポジトリとログに置かない。
- ログ・観測・応答に**本文・ヘッダ・トークンを出さない**（[observability](observability.md) の allowlist）。

## 変わったとき

- 入口の方式を変える: 決定の追記 + このファイル + edge の実装 + 401 のテスト。
- セッションの形（cookie 名・payload・属性）を変える: このファイル + codecs + すべての 401 テスト。

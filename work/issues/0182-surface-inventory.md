# 0182: GraphQL 以外の面を、どの issue がどの形で足すかを決める

status: open
priority: next
design: agreed
design-ref: D077
depends-on: 0179
touches: docs/, work/issues/, packages/web/, packages/server/

## Goal

0188 で REST の宣言（49 本の ROUTES と schema、web の typed client）を全部消した。D059 により、REST 面は
「それを実装する issue が schema・認証・handler を同じ変更で足す」。ここでは、GraphQL に載らない面を
**どの issue が・どこに・どんな認証で**足すかと、TanStack Query を残す範囲を決める。

## Acceptance criteria

- [ ] 面ごとに「実装する issue / 置き場（server 内のパス）/ 認証 / 理由」を1行ずつ決める
      （passkey・secrets・files・hooks・運用（metrics / usage / events）・me・machine）
- [ ] chat の送信面を決める（WS のメッセージか REST POST か）。0159 / 0176 と整合させる
- [ ] GraphQL の書き込み面（Mutation root）の担当を決める（0176 は Query だけ）
- [ ] TanStack Query を残す範囲を決める（画面状態と、GraphQL 以外の面）
- [ ] 0036 / 0100 / 0188 と docs の記述を更新する
- [ ] `npm run check` が通る

## Notes

- 0188 で 49 ルートと typed client は削除済み。**分類表は作らない**（分類する対象がもう無い）。
- D055 の「22 本は REST に残す」は D059 で撤回した。面は実装と同時に宣言する。
- 実装そのものは、各行が指す issue が持つ。

## Design（D077 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D077）。実装は受入（docs と issue の更新）で行う。

### 前提（いまの契約）

- 契約は GraphQL（`POST /graphql`、session cookie、未認証 401、0145 / 0176）。読みは Relay（D074）。
- 0176 は Mutation を 400 で拒否し、`buildSchema` は Query root しか取らない。**書き込みの面（Mutation root）が存在しない。**
- D059: REST は、実装する issue が schema・認証・handler を同じ変更で足す。宣言だけの面を置かない。
- 0145: 入口は1つ。認証・相関 ID・上限は edge。面以外は 404。
- docs/auth.md は REST の面を「passkey・files・hooks・運用・machine」と列挙している（本文は 0188 前で、実装は未着手）。

### 決定 1: 面の割り当て

| 面 | 実装する issue | 置き場 | 認証 | 理由 |
| --- | --- | --- | --- | --- |
| passkey | 0158 | `server/src/auth/passkey.ts` | 公開（login）+ enroll（初回 register）+ session（端末追加） | ログイン前に呼ぶ。cookie を発行する側なので GraphQL の外 |
| me | 0158 | `server/src/auth/me.ts` | 公開（未ログインは `authenticated: false`） | app を mount する前にログイン状態を知る。GraphQL は session 必須で使えない |
| secrets | 0107（0069 / 0071 の store） | `server/src/graphql/mutations/secrets.ts` | session + unlocked DEK | 通常のアプリ書き込み。値は返さない。Settings と同じ変更で足す（D059） |
| files（tree / search） | 0125 | `server/src/files/tree.ts` | session + project root | パスの列挙と部分欠落は REST が自然。本文を GraphQL に載せない |
| files（content read / write） | 0157 | `server/src/files/content.ts` | session + project root + expectedVersion | 大きな本文・版・ETag |
| hooks | 0038 | `server/src/hooks/` | token（session 無し） | 外部の Automation から呼ばれる。token は service 鍵で復号して照合 |
| 運用（metrics / events / usage） | 0039 | `server/src/obs/` | session | 画面外の監視から読む。期間・ページングは REST |
| machine（登録・疎通） | 0148 | `server/src/machines/` | session（登録）+ デバイス鍵（マシンの呼び出し） | マシンは cookie を持たない。1面で認証が2つに分かれる |
| chat の送信 | 0159 | `core/src/stream.ts`（WS メッセージ）+ `server/src/ws.ts` | WS upgrade の session | 開いた接続に載せる。順序と delta が同じ経路。二重は `clientMessageId` で防ぐ |
| GraphQL の書き込み | **新規 0198** | `core/src/graphql/schema.ts`（Mutation root）+ `server/src/graphql/mutations/` | session（resolver ごとに認可） | 0176 は Query だけ。この面が無いと 0104 / 0105 / 0117 / 0123 / 0126 / 0127 / 0131 が着手できない |

- `/api/health` は作らない。0145 の3面を維持し、生存は配備と `/api/metrics`、sandbox は 0148 の署名付き health で見る。
- GraphQL に寄せる（AC の `/api/*` を Query / Mutation に読み替える）: 0115, 0117, 0121, 0122, 0123, 0124, 0126, 0127, 0131。REST のまま残すのは上の表だけ。
- secrets のロックは HTTP 423 ではなく、GraphQL の union（`SecretListLocked`）で返す。0107 の「423 をロックとして表示」は UI の状態名として読む。

### 決定 2: 認証の入口

- edge（0145）のルート表を1つにし、行を `path / method / auth / handler` にする。`auth` は `session` / `public` / `enroll` / `hook` / `device` の閉じた union。
- どの面がどの認証かを宣言するのはこの表だけ。認証の実装は面のモジュールが持つ（docs/auth.md の「表を二重管理しない」）。
- 表は最初に landing する REST 面が導入する。0158 は後から行を足す。表を導入するまで抽象を作らない。
- session cookie は `Secure` / `HttpOnly` / `SameSite=Lax` / `Path=/`（0158）。状態を変える面は、ブラウザからの要求で `Origin`（または `Sec-Fetch-Site`）を確認する。hook と machine は対象外。
- body・期限・相関 ID の上限は edge の既存のものを使い、面ごとに作り直さない。

### 決定 3: TanStack Query の範囲

- 1つのデータに1つのキャッシュ。GraphQL は Relay、REST は TanStack Query、画面の一時状態は React の state。
- Query は REST 面のサーバ状態だけ（files / 運用 / machine 一覧）。passkey は mutation だけなのでキャッシュしない。`/api/me` は mount 前の1回なので素の fetch。
- いまの Shell の `summarySource`（fixture の `useQuery`）は 0115 が GraphQL になった時点で消す。0100 に暫定と書く。
- 同じデータを Relay と Query の両方に置かない。

### 決定 4: 実装で更新するもの

- 0036（画面と面の対応）、0100（REST の面と Query の範囲）、0188（chat の送信面の決定）、docs/auth.md（面の表）を更新する。
- docs/observability.md・docs/limits.md の `/api/*` を現在の面に合わせる。
- 0158 の AC に `/api/me` と初回登録の条件を足し、`touches` に `packages/server/src/edge/handler.ts` を足す。
- 0159 の AC に chat の送信（`send` / `accepted` / `rejected`、`clientMessageId`）を足す。
- 0107 の `depends-on` に 0069 / 0071 を足す（secrets の store を使う）。
- 0039 の AC に `/api/usage` を足す。
- 削除済みパスの掃除: 0115 / 0117 / 0122 / 0123 / 0124 / 0125 / 0126 / 0127 / 0131 の `core/src/http.ts` を `touches` から外す（0188 の残件）。0157 の `routes/files.ts` は `files/content.ts` に直す。

### 決定（D077）

- 初回 passkey は `HNS_ENROLL_TOKEN`。users 0 で未設定なら登録を閉じる。
- secrets は 0107 が持つ（独立 issue にしない）。
- chat の送信は WS（`send` / `accepted` / `rejected`）。REST POST は作らない。
- Mutation 面は新規 0198。Query と同じく面を1つのモジュールにし、feature ごとに `mutations/<name>.ts` を足す。

## やらないこと

- この issue での実装（順序・置き場・認証を決めるだけ）。

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: 0188 で REST 契約を撤去したため、「49 の分類」から「面ごとの再導入」に書き換え。
- 2026-11-17: 設計案を追加（レビュー待ち）。Mutation 面が無いことを見つけ、新規 0198 を提案。
- 2026-11-17: ユーザーの設計レビューで合意（D077）。U-01〜U-04 を決定し、`design: agreed` にした。

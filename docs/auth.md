# 認証: passkey とデバイス鍵

> 追記（D047）: tailnet の入口認証は **0158 でデバイス鍵に置き換える（未実施）**。以下の tailnet の記述は履歴として読む。

2026-11-06 / 要件13。共有 token（0019）の限界と、次の段。

## なぜ token だけでは足りないか

- URL に載るので履歴・ログ・コピペで漏れる。端末ごとの失効ができない。
- 「誰が」が分からない。監査も権限もユーザー単位にできない。
- 通信は TLS 前提でも、アプリ側の入口は 1 本の鍵。

## tailnet の ID を使う（履歴。0158 で置換）

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

## 面ごとの認証（契約）

GraphQL の `/graphql` はセッション cookie を要求し、resolver が対象ごとに認可する。
REST の面（passkey・files・hooks・運用・machine）は、それを実装する issue が認証方式を同じ変更で宣言する
（D059。宣言だけの面は置かない）。認証の入口は Worker に1つ置き、面ごとの表を二重管理しない。

## セッション cookie（0145）

- cookie 名は `hns_session`。値は `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`。
  payload は `{v:1,sub,exp}`（`exp` は unix 秒）。署名の対象は payload の base64url 文字列。
- Worker は `HNS_SESSION_SECRET`（32文字以上）で検証する。未設定、短すぎる、期限切れ、署名不一致、
  `v` が 1 でない、`sub` が空、同じ名前の cookie が複数、はすべて 401。既定値への fallback はしない。
- `Set-Cookie` の属性（`Secure` / `HttpOnly` / `SameSite=Lax` / `Path=/` / 30日）を付けるのは 0158。
  0145 は値の署名（`signSession`）と検証（`readSessionCookie`）を持つ。
- `Authorization: Bearer` や `?token=` をセッションの代わりに使わない。

## 秘密の配置（0143、設計）

> 実装は 0151（gateway）・0147（machine / hide）・0158（認証）。この節は置き場所の決定で、コードはまだ無い。

原則: **エージェントループのコードと同じ信頼領域に鍵を置かない。** 鍵ごとに「置く場所」「使う主体」「置かない場所」を決め、
信頼領域を跨ぐときは最小権限と短い寿命で渡す。

| 秘密 | 置く場所 | 使う主体 | 置かない場所 | 失効・ローテーション |
| --- | --- | --- | --- | --- |
| provider 鍵（Ollama / OpenCode 等） | gateway Worker の secret（0151）。provider ごとに1つ | gateway だけ | harness の isolate / Session DO / マシン / repo / ログ | 漏洩: 止める → 旧鍵を失効 → 新鍵 → 確認 → 再開。定期: 新鍵 → 確認 → 旧鍵を失効 |
| git・gh の資格情報 | マシンの git credential helper / OS keyring（`~/.config/hns` の外）。Cloudflare には渡さない | マシン上の git / gh | Cloudflare / DO / repo / エージェントの env | fine-grained / 短期の token。漏洩時は provider で revoke → 再発行 |
| webhook token | D1 に暗号文（service 鍵で暗号化）。平文は発行・再表示の応答だけ | Worker の webhook 受付 / 所有者の再表示 | DO / machine / ログ / repo | automation ごとに rotate。archive 後も URL を保持し、物理削除しない |
| service 秘密の暗号化鍵 | Worker の secret | Worker（service 秘密の暗号化・復号） | repo / ログ / マシン / エージェント | rotate は service 秘密と webhook token の再暗号化。失効は全 service 秘密と webhook の停止 |
| DEK | DO に **包んだ DEK** だけ（PRF 包み・復旧コード包み）。平文は unlocked 中のブラウザとサーバセッションのメモリだけ | ブラウザ（PRF unwrap）/ サーバセッション（unlocked） | DO の永続ストレージ（平文） / ログ / マシン | パスキー追加・復旧コード再発行で包み直す。紛失端末の包みは削除。漏洩時は作り直す |
| マシンのデバイス鍵 | 秘密鍵はマシン（0600）。公開鍵は D1 の Machine レコード（D049） | machine agent / Worker | Cloudflare に秘密鍵を置かない | D1 の公開鍵を無効化 → 再登録 |
| cloudflared tunnel token | マシンの secret（0600、`~/.config/hns/cloudflared`）。agent の bash からは hide | cloudflared だけ | Cloudflare / repo / ログ / エージェントの env | tunnel を再作成して token を入れ替える |
| セッション cookie の署名鍵 | Worker の secret | Worker | repo / クライアント | rotate すると全セッションが切れる（許容） |

### gateway（provider 鍵）

- provider 鍵は **gateway Worker の secret だけ**に置く。harness（Session DO）は gateway を service binding で呼び、
  鍵も provider の URL も持たない。マシンは provider を直接呼ばない。
- gateway は「モデル呼び出し」だけを受ける。任意 URL の proxy にしない（0151）。
- **支出上限**を二重に持つ: provider 側の hard limit / alert と、gateway の D1 予算行（日次・月次）。
  gateway は `UPDATE ... WHERE spent < limit` が 0 行なら 429。
- **緊急停止**は D1 のフラグで行う。デプロイを待たず 503。停止中は新しいモデル呼び出しを一切通さない。
- 鍵のローテーション: 漏洩時は「停止 → 旧鍵を失効 → 新鍵 → 1 回だけ疎通確認 → 再開」。
  定期は「新鍵を追加 → 疎通確認 → 旧鍵を失効」。失効の順序を leak と定期で混ぜない。

### マシン（git・gh）

- git はマシンで動くので、資格情報は **Cloudflare に置かない**。代わりにマシンの git credential helper /
  OS keyring に置き、エージェント用のユーザー・fine-grained token・短い寿命で被害を有界にする。
  デバイス鍵・cloudflared token を置く `~/.config/hns` とは分ける（provider 鍵はマシンに無い）。
- これは「エージェントと同じ信頼領域に鍵を置かない」の**例外**である。git を実行する以上、マシンは git 資格情報を
  読める。例外を許す条件は、リポジトリ単位の権限・短い寿命・監査・失効手順が揃っていること。
- provider 鍵・DEK・デバイス鍵はこの例外に含めない。provider 鍵はマシンに置かず gateway だけが持つ。
  sandbox の hide で `~/.config/hns` を隠し、デバイス鍵・cloudflared token をエージェントの bash から読めなくする（0147 / 0052）。
  git 資格情報はその外に置き、エージェントは git を使えるが provider 鍵は読めない、という分担にする。
  helper / keyring を sandbox の bash からどう使うか（repo 設定 / `GIT_CONFIG_GLOBAL` / keyring の bind）は 0147 で決める。
  エージェントは git の読み取り・fetch を使える。commit / push は製品側の操作に限定し、`.git` の書き込みは 0147 で拒否する。

### DEK とデバイス鍵

- DEK は **包んだまま DO** に置く。平文は unlocked 中のブラウザとサーバセッションのメモリだけ（D019）。
  復旧コードはサーバ側で開く（D020）。DO の永続ストレージ・ログ・マシンには置かない。
- 復旧コードの包みは別に持つ。どちらの包みも DEK を直接保存しない。
- 紛失した端末の包み（`user_keys` の行）は削除する。他の包みは残す（D021）。
- マシンのデバイス鍵は秘密鍵をマシンに、公開鍵を D1 の Machine レコードに置く（D049）。秘密鍵を Cloudflare に送らない。
- セッション cookie の署名鍵は Worker の secret。rotate は全セッション失効として扱う。

### sandbox の前提

- **hide が配線されていない環境では exec を提供しない（fail closed）。** `createSandboxEnv({ hide: [join(homedir(), ".config/hns")] })`
  のように絶対パスで渡して起動時に配線し、エージェントの bash からデバイス鍵・cloudflared token を読めないことを
  実機で確認する（bwrap 無しは SKIP）。provider 鍵は harness 側に無いことを 0151、machine 側に無いことを
  0147 の env / process テストで固定する。
- 0052 は 0147 に統合済み。0147 の受入条件に「hide の配線」と「隠した場所からデバイス鍵が読めないテスト」を
  追加済み（2026-11-11）。
- hide を `~/.ssh` まで広げると git の SSH 設定・鍵が見えなくなる。npm は `~/.npmrc` / キャッシュ。
  MVP では `~/.config/hns` を必須にし、他は必要になってから足す。

### 漏洩時の封じ込め（1ページ）

1. **止める（全秘密）**: gateway を緊急停止し、provider の該当キーを失効する。git / gh の token を revoke する。
   webhook は該当 automation を停止して token を rotate する。デバイス鍵は D1 の公開鍵を無効化する。
   service 鍵が漏れたら service 秘密と webhook を停止する。cloudflared token が漏れたら tunnel を停止して
   token を失効する。DEK が漏れた疑いがあれば、unlocked セッションをロック / 失効する。
2. **広がりを見る**: provider の利用ログ、gateway の予算、`events`（秘密は残っていない）、どの Run / project が
   その鍵を使えたかを確認する。
3. **入れ替える**:
   - provider / git / webhook / cloudflared は新しい値に入れ替え、疎通確認する（漏洩時は step 1 で旧値を失効済み。
     定期ローテーションは疎通確認後に旧値を失効する）。
   - service 鍵を入れ替え、service 秘密と webhook token を再暗号化する。cloudflared token は tunnel を
     作り直して入れ替える。
   - デバイス鍵は再登録する。
   - DEK が漏れたら、新しい DEK を作り、**全 user 秘密を新 DEK で再暗号化**してから包みを包み直す。
     旧 DEK は漏れたものとして扱う。旧暗号文・バックアップ・R2 に残るコピーは旧 DEK で復号できるため、
     「消えた」と書かない。必要なら該当データを削除する。
4. **利用者に伝える**: 影響範囲、止めた機能、再開の条件を伝える。DEK の再暗号化が終わるまで再開しない。
5. **記録する**: 何が漏れ、どこまで使われ、何を失効し、いつ再開したかを issue / decisions に残す。
   秘密そのものは書かない。

TTL の目安: provider 鍵は四半期ごと、git token は 30 日、webhook token は rotate 時（archive 後も保持）、
デバイス鍵はマシンの再登録時、cloudflared token は tunnel の再作成時、service 鍵とセッション署名鍵は年1回
（または漏洩時）。

## テスト手段（実装済み）

ブラウザの認証器は Playwright の**仮想オーセンティケータ**で再現する。

- `playwright-core` + Nix の Chromium（`HNS_CHROME` で上書き）。
- CDP: `WebAuthn.enable` → `WebAuthn.addVirtualAuthenticator`（ctap2 / internal / UV 済み）。
- `run-passkey.mjs` が 登録 → 未ログインで 401 → ログイン → セッションで 200 まで通す。
- `hasPrf: true` の仮想認証器で `run-prf.mjs` が PRF の包み・復旧コード・再起動後のロックまで通す。
- Chromium が無い環境では SKIP する。

## 暗号化・復号化（実装済み）

秘密は**スコープで分ける**（実装済み）。§user§ は人のもの、§service§ は Automation 用。
§secrets.mjs§ が AES-256-GCM で保存し、§getService§ は §user§ を読めない。
Provider 鍵は §service/provider.<name>§ に置けば、ファイルや env を汚さずに使える（PoC の履歴）。
**0151 以降、provider 鍵は gateway Worker の secret だけに置く（上の「秘密の配置」。0151 は未実装）。**

### PRF で包む（実装済み）

- 登録時: データ鍵（DEK）を作り、**複数の包み**を保存する。PRF から HKDF で作った KEK で包む包みと、復旧コードから PBKDF2 で作った KEK で包む包み。
- ログイン時: 同じ KEK で DEK を開き、`/api/passkey/unlock` でセッションに渡す。DEK は**メモリだけ**に置く。
- 再起動やログアウトで DEK は消える。その状態で `user` の秘密を読むと `423 locked`。
- PRF 非対応の認証器でも復旧コードの包みは作る。その端末ではパスキーでは開けないが、復旧コードで開ける。
- Automation は `service` しか使わないので、誰もログインしていなくても動く。

### 2台目のパスキー（実装済み）

unlocked のセッション中に `/api/passkey/add/options` → ブラウザが `/api/passkey/dek` で DEK を受け取り、
新しい認証器の PRF で包み直して `add/verify`。既存の包みは残る。
DEK を返すのは unlocked の間だけ。XSS はこの境界を破れるので、CSP と入力の扱いが前提。

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

| ID        | 論点                                        | 案                                                             |
| --------- | ------------------------------------------- | -------------------------------------------------------------- |
| ~~AR-01~~ | passkey を第一手段にするか tailnet の補助か | **解消**: 0158 で tailnet を廃止し、passkey + デバイス鍵にする |
| AR-02     | PRF 非対応の認証器                          | 復旧コードで開ける（実装済み）                                 |
| AR-03     | 復旧                                        | リカバリコードを紙で保管                                       |
| AR-04     | セッションの寿命と失効                      | 端末ごと、30 日 + 明示ログアウト                               |

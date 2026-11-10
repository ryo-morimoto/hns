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

## 秘密の配置（0143）

原則: **エージェントループのコードと同じ信頼領域に鍵を置かない。** 鍵ごとに「置く場所」「使う主体」「置かない場所」を決め、
信頼領域を跨ぐときは最小権限と短い寿命で渡す。

| 秘密 | 置く場所 | 使う主体 | 置かない場所 | 失効・ローテーション |
| --- | --- | --- | --- | --- |
| provider 鍵（Ollama / OpenCode 等） | gateway Worker の secret（0151）。provider ごとに1つ | gateway だけ | harness の isolate / Session DO / マシン / repo / ログ | gateway を止める → provider で旧鍵を失効 → 新しい鍵を secret に入れる → 再開 |
| git・gh の資格情報 | マシンの git credential helper / OS keyring（`~/.config/hns` の外）。Cloudflare には渡さない | マシン上の git / gh | Cloudflare / DO / repo / エージェントの env | fine-grained / 短期の token。漏洩時は provider で revoke → 再発行 |
| webhook token | D1 に **hash** だけ。平文は発行時に一度だけ返す | Worker の webhook 受付 | DO / machine / ログ / repo | automation ごとに rotate。失効は行の削除 |
| DEK | DO に **包んだ DEK** だけ（PRF 包み・復旧コード包み）。平文は端末のメモリだけ | ブラウザ（PRF unwrap） | サーバ / DO / ログ / マシン | パスキー追加・復旧コード再発行で包み直す。DEK は変えない |
| マシンのデバイス鍵 | 秘密鍵はマシン（0600）。公開鍵は D1 | machine agent / Worker | Cloudflare に秘密鍵を置かない | D1 の公開鍵を無効化 → 再登録 |
| セッション cookie の署名鍵 | Worker の secret | Worker | repo / クライアント | rotate すると全セッションが切れる（許容） |

### gateway（provider 鍵）

- provider 鍵は **gateway Worker の secret だけ**に置く。harness（Session DO）は gateway を service binding で呼び、
  鍵も provider の URL も持たない。マシンは provider を直接呼ばない。
- gateway は「モデル呼び出し」だけを受ける。任意 URL の proxy にしない（0151）。
- **支出上限**を二重に持つ: provider 側の hard limit / alert と、gateway の D1 予算行（日次・月次）。
  gateway は `UPDATE ... WHERE spent < limit` が 0 行なら 429。
- **緊急停止**は D1 のフラグで行う。デプロイを待たず 503。停止中は新しいモデル呼び出しを一切通さない。
- 鍵のローテーション: 停止 → 新鍵を secret に投入 → 1 回だけ疎通確認 → 再開。旧鍵は provider 側で失効。

### マシン（git・gh）

- git はマシンで動くので、資格情報は **Cloudflare に置かない**。代わりにマシンの git credential helper /
  OS keyring に置き、エージェント用のユーザー・fine-grained token・短い寿命で被害を有界にする。
  provider 鍵・デバイス鍵を置く `~/.config/hns` とは分ける（hide で隠すのは後者だけ）。
- これは「エージェントと同じ信頼領域に鍵を置かない」の**例外**である。git を実行する以上、マシンは git 資格情報を
  読める。例外を許す条件は、リポジトリ単位の権限・短い寿命・監査・失効手順が揃っていること。
- provider 鍵・DEK・デバイス鍵はこの例外に含めない。sandbox の hide で `~/.config/hns` を隠す（0147 / 0052）。
  git 資格情報はその外に置き、エージェントは git を使えるが provider 鍵は読めない、という分担にする。

### DEK とデバイス鍵

- DEK は **包んだまま DO** に置く。平文はログイン中の端末のメモリだけ（D019）。サーバは PRF の包みを開けない。
- 復旧コードの包みは別に持つ。どちらの包みも DEK を直接保存しない。
- マシンのデバイス鍵は秘密鍵をマシンに、公開鍵を D1 に置く。秘密鍵を Cloudflare に送らない。
- セッション cookie の署名鍵は Worker の secret。rotate は全セッション失効として扱う。

### sandbox の前提

- **hide が配線されていない環境では exec を提供しない（fail closed）。** `createSandboxEnv({ hide })` に
  `~/.config/hns` を渡し、エージェントの bash から provider 鍵・デバイス鍵を読めないことを実機で確認する。
- 0052 は 0147 に統合済み。0147 の受入条件に「hide の配線」と「隠した場所から鍵が読めないテスト」を含める。
- hide は `~/.ssh` まで広げるか別に判断する。広げるほど git / npm の設定も見えなくなるため、MVP では
  `~/.config/hns` を必須にし、他は必要になってから足す。

### 漏洩時の封じ込め（1ページ）

1. **止める**: gateway の緊急停止を立てる。provider のダッシュボードで該当キーを失効する。git / gh の token を revoke する。
2. **広がりを見る**: provider の利用ログ、gateway の予算、`events`（秘密は残っていない）、どの Run / project が
   その鍵を使えたかを確認する。
3. **入れ替える**: 新しいキーを gateway の secret / マシンの資格情報ストアに入れる。webhook token は該当 automation を
   rotate する。デバイス鍵が漏れたら D1 の公開鍵を無効化して再登録する。
4. **利用者に伝える**: 影響範囲、止めた機能、再開の条件を伝える。DEK の平文が端末から漏れた場合は、
   DEK を作り直して全包みを包み直す（パスキー・復旧コードも再発行）。
5. **記録する**: 何が漏れ、どこまで使われ、何を失効し、いつ再開したかを issue / decisions に残す。
   秘密そのものは書かない。

TTL の目安: provider 鍵は四半期ごと、git token は 30 日、webhook token は automation の削除時、デバイス鍵は
マシンの再登録時、セッション署名鍵は年1回（または漏洩時）。

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
**0143 以降、provider 鍵は gateway Worker の secret だけに置く（上の「秘密の配置」）。**

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

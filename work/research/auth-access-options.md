# 認証・到達性の選択肢（0048 / 0158 の判断材料）

2026-11-17 / 比較（**決定: A Native、D079**）。0048 の U-01 と 0158 の入口認証を、単独案ではなく複数案で比べて決めるための資料。

## いまの記録（事実）

- 0021（tailnet の ID で認証）は **superseded**。0158 が置き換える。製品コードに tailscale 依存は無い（docs と PoC のみ）。
- 0158 の AC: tailnet の入口認証（D016）を廃止し、外部 IdP を使わない。passkey + PRF、マシンはデバイス鍵。
- D016（tailnet）→ D017（passkey + session cookie）→ D019〜D021（PRF で DEK を包む・復旧コード・2台目）。
- 0145 の cookie は stateless（`{v:1,sub,exp}`、sid 無し）。0048 U-03 で `sid` を足す。
- 0147 はマシンのデバイス鍵、0148 はマシン登録、0151 は provider 鍵を gateway の secret に分離、0159 は WS、0040 はセルフホスト。
- 0108 の「tailnet モード」は 0158 前の記述で stale。

**tailscale はどこへ**: 「0158 で外す」が記録。ただし 0158 は `design: pending` なので、ここで再判断してよい。

## 4つの層を混ぜない

| 層 | 問い | 選択肢 |
| --- | --- | --- |
| 到達性 | 誰が URL に届けるか | 公開 / Cloudflare Access / tailnet / tunnel |
| ブラウザの身元 | 誰か | passkey（hns） / Access の IdP / 共有 token |
| 秘密の鍵（DEK） | 誰が復号できるか | ブラウザの PRF / サーバの鍵 |
| マシンの身元 | どのマシンか | デバイス鍵（Ed25519） / Access の service token / 共有秘密 |

## 選択肢（bundle）

| 案 | 到達性 | ブラウザ | DEK | マシン | 一言 |
| --- | --- | --- | --- | --- | --- |
| **A Native**（0158） | 公開 | passkey + hns session | ブラウザ PRF | デバイス鍵 | 自前で閉じる。外部 IdP 無し |
| **B Access-only** | Access | Access の IdP | サーバ鍵 | Access service token | アプリは認証を持たない。サーバが秘密を復号できる |
| **C Hybrid** | Access | Access + passkey | ブラウザ PRF | デバイス鍵 | 二重の入口。最も強いが儀式が2回 |
| **D Tailnet** | tailnet | tailnet の ID（whois） | ブラウザ PRF | デバイス鍵 | Workers では不可。セルフホスト専用 |
| **E 共有 token**（0019） | 公開 | token | サーバ鍵 | 共有秘密 | 失効・端末分離が無い。却下 |

## 比較

| 観点 | A Native | B Access-only | C Hybrid | D Tailnet |
| --- | --- | --- | --- | --- |
| フィッシング耐性 | passkey で高い | IdP 次第（passkey 可） | 高い | 端末依存 |
| 端末ごとの失効 | `sid` + sessions（0048） | Access のセッション | 両方 | tailnet の端末削除 |
| 秘密を復号できるのは | ブラウザ（unlocked 中） | サーバ | ブラウザ | ブラウザ |
| WebSocket（0159） | 問題なし | **Worker destination の Access は WS upgrade を 403 にする報告**（2026-07、open） | 同じ（回避策が要る） | 問題なし |
| セルフホスト（0040） | 可 | 不可（Access 依存） | 可（Access 無しでも動く） | 可（tailnet 前提） |
| 開発・テスト | 仮想 authenticator で可 | JWT/AUD の fixture、Access bypass | 両方 | tailnet が要る |
| 外部依存・費用 | 無し | Cloudflare Zero Trust + IdP | 両方 | tailnet |
| 実装量 | 0158 + 0070 + 0071 + 0108 | JWT 検証 + 設定 + マシン token | A + Access | 0158 の一部 + whois |
| UX | 1回の passkey | SSO 1回 | 2回（Access + unlock） | 端末が tailnet に居れば1回 |

## 外部の事実（2026-11 時点）

- Cloudflare Access は Worker を前段で守れる。JWT は `Cf-Access-Jwt-Assertion`、`TEAM_DOMAIN` の JWKS と `POLICY_AUD` で検証する（[Workers の Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、[JWT の検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)）。workers.dev / Preview は one-click で有効化できる（[changelog 2025-10-03](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)）。
- マシンや自動化は service token（Client ID / Secret）で通せる（[service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)）。coding agent 向けの cloudflared / service token の案内もある（[Authenticate coding agents](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/)）。
- **Access を Worker destination に付けると WebSocket upgrade が 403 になる**という docs issue が 2026-07 から open（[#31885](https://github.com/cloudflare/cloudflare-docs/issues/31885)）。custom hostname で回避できるかは未確認。hns は 0159 で WS を使うので、これは決定的な検証項目。
- PRF の対応（2026-09 のまとめ、[Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn)）: Android / Google Password Manager は広い、Windows Hello は 2026-02 以降、Safari 18+ / macOS 15、Chrome 147 で create、Firefox 148+。**第三者のパスワード管理は 100%〜0% とばらつく**。復旧コードは必須。
- tailnet の ID は tailnet 上のホストで `whois` して得る。`tailscale serve` のヘッダは詐称できるので信じない（docs/auth.md の方針）。Workers は tailscaled を持てないので、**Cloudflare 上の入口では tailnet の ID を取れない**。

## 評価

- **A**: 自前で閉じ、DEK をブラウザから出さず、WS とセルフホストにそのまま載る。実装は重い（WebAuthn / PRF / 復旧 / 端末追加）が、0158・0070・0071・0108 の範囲としてすでに見積もってある。
- **B**: 実装は最小。その代わり **サーバが user 秘密を復号できる**（PRF/DEK を捨てる）ので、D019〜D021 の前提が変わる。外部 IdP と Access の設定が製品の外に出る。0040 のセルフホストは別の入口が要る。
- **C**: 最も強いが、Access と passkey の2回の儀式、2つの設定、WS の 403 回避が要る。単一ユーザーには過剰になりやすい。
- **D**: セルフホスト（0040）の transport としては有力。Cloudflare 配備の既定にはできない（Workers で tailnet ID を取れない）。

## 推奨

1. **製品の既定は A**（passkey + session + PRF + デバイス鍵、tailnet は外す）。DEK をブラウザの外に出さず、WS / セルフホスト / 単一ユーザーに素直に合う。
2. **C は運用オプション**（Access を前段に置きたい人のため）。依存にはしない。
3. **D は 0040 のセルフホスト transport** として残す（入口の身元は passkey）。
4. **B は「サーバが秘密を復号してよい」と決めた場合だけ**。そのなら D019〜D021 と 0048 の credentials/user_keys を見直す。
5. **E は却下**（0019 の履歴）。

ただし、次のどれかが成り立つなら C を選ぶ価値が上がる: (a) Access の WS が custom hostname で通ることを実測できる、(b) SSO / 端末 posture を製品として要求する、(c) passkey の実装・復旧の負担を外部に寄せたい。

## 決めてほしいこと

| ID | 問い | 選択肢 |
| --- | --- | --- |
| A-01 | bundle | A / B / C / D |
| A-02 | DEK をブラウザに残すか | 残す（PRF） / サーバ鍵にする |
| A-03 | マシンの身元 | デバイス鍵 / Access service token / 両方 |
| A-04 | Access を使うなら WS | custom hostname で実測 / /ws を Access の外に置く / WS をやめる |
| A-05 | tailnet の位置づけ | 製品から外す / 0040 の transport だけ |

## 影響（bundle 別）

| bundle | 0048 のテーブル | 0158 の入口 | 0108 の UI | マシン |
| --- | --- | --- | --- | --- |
| **A Native** | users / credentials / sessions / user_keys / secrets | passkey + session cookie + sid | passkey 登録・ログイン・復旧 | デバイス鍵（0147） |
| **B Access-only** | users / secrets だけ（credentials / user_keys / sessions は不要。秘密はサーバ鍵） | Access の JWT 検証（`Cf-Access-Jwt-Assertion`、AUD / team domain） | ログイン画面は無し。`/api/me` は JWT の identity | Access の service token（または device key を併用） |
| **C Hybrid** | A と同じ + Access JWT の検証 | Access + passkey（DEK の unlock） | Access のログイン + passkey の unlock | デバイス鍵 |
| **D Tailnet** | A と同じ | tailnet の whois（セルフホストのみ） | passkey / whois | デバイス鍵 |

- B を選ぶと D019〜D021（PRF / DEK / 復旧）の前提が変わる。秘密をサーバ鍵で暗号化するなら、0048 の credentials / user_keys と 0158 の PRF は不要になり、0069 の cipher が Worker の鍵で動く。
- A / C / D は 0048 の起草どおり。C は 0048 に「Access の JWT を検証する」責務を足さない（0145 / 0158 の境界）。

## 出典

- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Access JWT の検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Access の WebSocket 403（docs issue #31885）](https://github.com/cloudflare/cloudflare-docs/issues/31885)
- [PRF の対応状況（Corbado, 2026-09）](https://www.corbado.com/blog/passkeys-prf-webauthn)
- [one-click Access for Workers（2025-10）](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)

# 設計レビュー待ちのまとめ（2026-11-17）

lead が作成。7 件の設計案を、決定・根拠・残リスク・承認すると決まることに絞って並べる。詳細は各 issue。

## 1. 0106: Editor 右パネル

**決定案**: EditorBuffer を React の外の状態機械（closed/loading/clean/dirty/saving/conflict/unknown/readonly/error）。一覧は 0125 の GraphQL、保存は 0157 の REST（`expectedVersion` + `operationId`）。conflict は再読込 / 上書き、unknown は再読込 + ハッシュ照合で**成功扱いにしない**。dirty guard、`?file=`、モバイル全画面、行 diff。

**エディタ**: 要件比較の結果 **CM6**。Monaco はモバイル非対応 + 約2.9MB、自作は IME / a11y / 長いファイルを自前で持つため却下。`work/research/editor-selection.md`。

**NFR**: lazy ≤350KB gzip、open p95 ≤500ms、入力 p95 ≤16ms、保存 p95 ≤1s、tree p95 ≤300ms、1MB で +100MB、WCAG 2.2 AA、44px、CSP、8MiB 超は read-only。共通 baseline は `docs/web-client-nfr.md`（初期 JS ≤250KB gzip、現状 208.9KB）。

**残リスク**: CM6 の実バンドルサイズ、モバイル IME の実機確認（0113）、0157 の content 面の確定。

**承認すると決まること**: U-01〜U-06（U-06 = CM6）、NFR の目標値、D090（仮）。

## 2. 0191: workspace の実行性能

**決定案**: 1 root = 1 常駐 child（A）。現行 write p50 150.7ms（2 spawn）→ 常駐で 0.22ms。B（1往復）は 74ms、D は 43.5ms で不足。worker は起動 9.8ms だが seam / build / 隔離の代償で次点。

**Protocol**: `HelperPort` + NDJSON + id、hello で root / dev / ino、直列、16MiB 行上限、chunk framing、timeout kill。crash は 1回再起動 / 60秒3回で fail closed、checks に落とさない。idle 60s（unref）+ `Rooted.close` + `Workspace.close`。

**計測**: write p95 <10ms、integration <3s（現状 6.8s / 48 tests、churn 3053ms が spawn 支配）。ゲートに run 単位の時間。

**残リスク**: helper の RSS 約73MB / root（LRU 上限）、probe の 38–74ms は残る、test pool は 3s 超過時のみ。

**承認すると決まること**: U-01〜U-05、`HelperPort` の導入、close 契約、ゲートの時間出力。

## 3. 0160: UI の配信（**承認済み / D094**）

**決定案**: Workers Assets + edge の手動 SPA fallback（navigation + Accept html のみ。`/api` は 404 のまま、`/assets` は 404）。assets immutable / index no-cache。typed client は Relay codegen（0037 の記述を削除）。custom domain 既定、workers.dev は dev/CI。未認証は `/graphql` 401 + クライアントで `/login`。CSP / nosniff / no source map。Vite proxy で `/graphql` / `/api` / `/ws`。

**確認済み**: 現行 `ws` は Origin 検証なし（0165 が直す）。`vite.config` に proxy なし、`cloudflare.config` に ASSETS なし。

**残リスク**: CSP の `style-src 'unsafe-inline'` の範囲、WS の `connect-src 'self'` の実機確認、index の no-cache が CDN で効くか。

**承認すると決まること**: U-01〜U-06、配信形態、ドメイン、キャッシュ、CSP。

## 4. 0194: machine の sandbox（**承認済み / D095**）

**決定案**: exec は bwrap のみ（無ければ拒否）。`--ro-bind / /` → `--tmpfs <ROOT>` → `--bind <projectRoot>` → `.git` を ro-bind。固定 hide リスト、env allowlist、egress は deny（`--unshare-net`）/ inherit。allowlist は v1 で deny に倒す。ROOT marker を確認。

**`.git`**: docs/safety.md / docs/workspace.md が「読み取りのみ」。agent の sandbox では commit しない。checkpoint / commit は 0154 / 0156 の特権経路。

**現行との差分**: hide は caller 指定 → 固定、HOME=root → 一時 dir、`--new-session` / `.git` ro / `--unshare-net` / `--tmpfs ROOT` を追加。

**残リスク**: inherit の egress（private range / metadata はホスト依存）、bwrap の版、HOME 変更のツール影響。

**承認すると決まること**: U-01〜U-05、mount / hide / env / egress の形。

## 5. 0165: 安全の再評価（**承認済み / D096**）

**決定案**: 信頼境界の棚卸し（browser / edge / DO / gateway / machine / sandbox / 運用者）。XSS→exec はテキスト描画 + CSP + HttpOnly/SameSite/Secure + JSON POST + **WS の Origin 検証**。サプライチェーンは exact pin / no runtime npm / deploy token = exec 権限。DO の egress は gateway binding と tunnel host だけ。事故時は machine 失効 / control-plane 鍵ローテーション / session 全失効 / automation 停止。

**確認済み**: `session.ts` は署名だけ（cookie 属性は 0108）、`ws.ts` に Origin 検証なし。0165 で ws.ts を触る。

**残リスク**: prompt injection → exec → egress（inherit の project）、依存 CVE の監視は別。

**承認すると決まること**: U-01〜U-04、WS Origin の追補、docs/safety.md の脅威表の更新。

## 6. 0181: store の鮮度方針（**承認済み / D097**）

**決定案**: 古いまま出るケース（再訪 / WS 取りこぼし / 別端末 / 索引の遅れ / 時間経過）を列挙し、画面ごとに方針を固定。

- transcript / 会話一覧 / ホーム / Needs you は **購読**（0159）+ reconnect で `resync` + refetch
- 設定 / providers / machines は **30 秒 TTL + focus で revalidate**（購読しない）
- Editor 本文・file tree は **network**（版 / 展開ごと）
- 切断中は「再接続中（古い可能性）」、索引の遅れは「更新中」を**別々**に出す。黙って古い値を出さない
- ポーリングしない。画面を離れたら購読 / in-flight を abort

**残リスク**: Relay の fetchPolicy を画面単位で切り替える方法、`resync` の実挙動、TTL の体感。

**承認すると決まること**: U-01〜U-05、画面ごとの取得方針、古さの表示。
## 7. 0043: 製品の E2E（**承認済み / D099**）

**決定案**: Playwright（user 決定）+ Phase 1/2。`e2e/{pages,fixtures,journeys,support}`。Phase 1 は `wrangler dev`（local D1/DO）+ Vite dev（0160 の proxy）、0160 後に Worker 配信でも 1 本。外部 provider だけ faux。

- seed は `HNS_E2E=1` のときだけ `/__e2e/seed`（本番 404）。UI でセットアップしない
- passkey は CDP の仮想 authenticator + `storageState`。RP ID は localhost
- `sleep` なし、WS 終端 / web-first assertion。retry 1、flake は quarantine。失敗時に trace / video / screenshot / log
- PR はスモーク3本、main / nightly で全部。CI は 0041 の後。Chromium のみ
- **ファイル編集のスモークは 0157 の後**。それまでは editor を開くところまで

**残リスク**: seed 用テスト経路の本番混入（env で 404 を固定）、仮想 authenticator の RP ID、0157 待ち。

**承認すると決まること**: U-01〜U-05、E2E の実行形態と seed / 認証の作り方。
## 承認の順番（提案）

1. 0106（UI の editor）と 0160（UI の配信）— UI レーンを開ける
2. 0191（workspace 性能）— テストと write の速度
3. 0194（sandbox）と 0165（安全）— machine / exec の前提

いずれも `design: agreed` にすると D090 以降を追記し、BOARD の設計待ちから外す。
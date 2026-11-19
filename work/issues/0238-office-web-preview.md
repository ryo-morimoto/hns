# 0238: web に PDF プレビューを置く

status: in-progress
priority: now
design: agreed
design-ref: D103, docs/office.md
depends-on: 0234, 0237
touches: packages/web/src/office/, packages/web/src/app/, packages/web/package.json, package-lock.json

## lead の補足（0237 の Result から）

- **`requestDocumentPreview(path, workspaceId)`**——**`workspaceId` を省略すると `not_authorized`**（fail closed）。画面は **Sidebar で選んだ workspace** を渡すこと。
- **`documentPreview` は `DocumentPreview | OfficeFailure`**。**行が無い**ときも **`engine_unavailable`**（**「未要求」と「エンジンが無い」は code で区別できない**——契約の穴。**画面は「未要求」を `request` して作る**ので、`documentPreview` の `engine_unavailable` を**「エンジンが無い」と断定しない**）。
- **`DocumentPreview.url`**（`/api/office/preview?workspaceId=…&path=…&v=…`）は **edge の同じ route**。**PDF.js はこの URL から range で読む**（`pdfjs-dist` の `disableRange: false`）。**machine の 8 MiB range と二重に range を取る**ので、**大きい PDF で正しく動くか**を実経路で 1 本。
- **`stale` は「結果を確認中」**で、**1 秒ポーリング**（**live は会話専用**）。**`bytes > 50 MiB` と 300 ページ超は読み込まない**（**PDF.js に渡す前に**）。

## Intent

「文書が開いて読める」という体験の本体。利用者がページを送り、拡大し、内容を確認できることが Phase 0 の完了条件。
PDF.js を使い、状態と失敗をそのまま見せる。

## Goal

workspace の docx / xlsx / pptx を開くと右パネルに PDF が表示される。準備中・失敗・結果不明・未設定・対象外の
5 つの異常も、次に何をすればよいか分かる形で出る。キーボードだけでページ送りできる。

## Acceptance criteria

- [x] `pdfjs-dist` を**正確な版で pin** して追加し、worker をバンドルする（CDN を使わない）
- [x] `ready` で PDF が表示され、ページ送り・ズーム・テキスト選択ができる
- [x] `queued` / `generating` はスピナー +「準備中」。**1 秒間隔のポーリング**（live は会話専用のため使わない）で切り替わる
- [x] query の失敗 union（`OfficeFailure`）を扱い、`not_authorized` を文言にする
- [x] `stale` は「結果を確認中」を出し、alarm の決着後に ready / failed に切り替わる
- [x] `failed` は code ごとの文言（docs §9）と再試行
- [x] `unsupported` は理由（形式）を出す。大きさの超過は `failed` + code として出す
- [x] `disabled` は「Office プレビューは未設定です」＋セットアップ手順
- [x] `bytes` > 50 MiB または 300 ページ超は PDF を読み込まずに案内を出す
- [x] キーボードでページ送り・ズーム・パネルから抜けられる

## テスト条件

- C1: 7 状態それぞれ → 正しい表示
- C2: `ready` の PDF → ページ数が `pages` と一致
- C3: 認可失敗 → パスワードやエンジンの情報を漏らさない
- C4: キーボードのみ → ページ送り・ズーム
- C5: `bytes` > 50 MiB → 読み込まずに案内
- C6: `stale` → 決着後に表示が切り替わる

## テスト設計

- T1: C1/C3/C5/C6 → 状態の table-driven → unit（コンポーネント）
- T2: C2 → fixture PDF → unit（境界で分ける）
- T3: C4 → キーボード → e2e（Playwright）

## Problem / context

web にはバイナリ文書の表示が無い（エディタはテキストのみ）。画像で出す案は拡大・選択・ページ送りができない。
PDF.js は追加のサービスを要求しないが、**依存の追加**なので決定と pin が要る。

## Users and use cases

- 利用者: 生成された提案書をその場で確認し、直す指示を出す。
- エージェント: プレビューの状態を会話で参照する。
- 運用者: 未設定・失敗の理由が画面で分かる。

## Non-goals

- 編集 UI（0240）。ブラウザ内編集（0010 は parked）。
- サムネイル一覧・検索。
- i18n の仕組み（web に無い。文字列は直書き）。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | PDF.js（`pdfjs-dist` pin） | 選択・拡大・ページ送りが標準 | 依存が 1 つ増える | 低 | 中 |
| B | サーバで PNG 化して画像で返す | 実装が軽い | 拡大でぼやける・選択不可・通信量 | 中 | 中 |
| C | iframe で外部の Office | 忠実 | 外部依存・認証・AGPL・ネットワーク | 高 | 大 |
| Do nothing | ダウンロードだけ | 実装しない | 「開いて読める」が無い | 中 | — |

## Recommendation

A。追加サービス無しで体験が成立する。B は読めない、C は D102・D103 と矛盾する。

## Design: guide-level

- 文書を選ぶ → 「準備中」→ 1.9 秒ほどで 1 ページ目（S12 の実測）。
- 失敗は「時間内に変換できませんでした」＋再試行。原本は壊れていないことを明記。

## Design: reference-level

- `PreviewPanel` は `documentPreview(path)` をポーリングし（生成中は 1 秒、ready/failed で停止）、`status` で分岐する。
- PDF は `url` を `pdfjs-dist` に渡す。worker を使い、メインスレッドを塞がない。
- サイズ判定は `bytes` と `pages`（query の field）で行う。

## Invariants and failure modes

- `url` が null のときは読み込みを開始しない。
- 状態は逆戻りしない（版が変わったら別の path/version として扱う）。
- PDF の読み込み失敗は `failed` として再試行を出す。

## Cross-cutting concerns

- accessibility: キーボード・ラベル・コントラスト。
- performance: worker + 遅延読み込み。
- security: PDF.js のサンドボックス設定を既定のまま。外部リンクは開かない。

## Compatibility, migration, rollback

新しいパネル。flag で無効化できる。依存は 1 つ（`pdfjs-dist`）。

## Test plan

unit（状態 → 表示）、e2e（キーボード・状態遷移）、visual（1 ページ）。

## Rollout and graduation

flag（`office.preview`）。Phase 0 の完了条件は「開いて読める」（0239）。

## Notes

- 契約: [docs/office.md](../docs/office.md) §6・§9。
- 実測: S12（1.86 s / 150 ページ）、S20（1.82〜1.83 s で安定）。

## 未確定

- U-01: パネルの置き場（既存の右サイドバーか、新しいタブか）/ 仮説: 既存のサイドバー / 影響: レイアウト / 責任者: user / トリガー: 実装前。

## やらないこと

- 編集・コメント・注釈・サムネイル一覧。
- i18n の仕組みづくり。
- Office の完全な再現。

## Log

- 2026-11-17: 作成。
- 2026-11-17: 独立レビュー 1 回目を受け、pdfjs-dist の pin、bytes 判定、stale、i18n 撤回、数値の出所を修正。
- 2026-11-17: レビュー 2 回目（N3/N4）対応: 購読をポーリングへ、失敗 union の扱いを追加。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

## Result

- verdict: **PASS**（reviewer-0238 → FAIL 1 → reviewer-0238b PASS）。**W-P1 は lead 裁定で問題なし**（下記）
- HEAD: d339b86（main に ff 統合）。gate は exit 0（2004 tests / 2005、main で 197.9s）。
- **`pdfjs-dist` 6.5.438 を pin** し、**worker をバンドル**（**CDN 不使用**）。**build 成果物に `pdf.worker.min-*.mjs` がちょうど 1 つ**出て、**bundle が指す URL は same-origin の root-relative で実在**。**main HEAD を build すると worker 0 個 / このブランチは 1 個**を実測。
- **7 状態の表示**: `queued` / `generating` はスピナー +「準備中」、`ready` は PDF（ページ送り・ズーム・テキスト選択）、`stale` は「結果を確認中」、`failed` は code ごとの文言 + 再試行、`unsupported` は理由（形式）、`disabled` は未設定 + セットアップ手順、`not_authorized` は失敗側の文言。**server の message は一切表示しない**。**`data-office-failure` で `not_authorized` を区別**（8 番目の状態は増やさない）。
- **`bytes > 50 MiB` / 300 ページ超は PDF.js に渡す前に**案内（**`panelViewOf` の 1 か所**）。**1 秒ポーリング**（live 不使用）。**キーボードのみでページ送り・ズーム・パネルから抜けられる**。
- **実経路 2 本**: ①**実 machine + 実 pack → Session → 実ルート → 実 `pdfjs-dist`**（ページ数が row の `pages` と一致）②**本物の Relay 環境 + 本物の SDL**。
- **レビューで見つかって直したもの（重大）**: **`PanelContent` が Shell に配線されていなかった**ので、**office のコードが build graph に入らず `pdf.worker` が emit されていなかった**。しかも**「パネルが閉じている」ように見えるので障害として露見しない**——**0239 の Phase 0 完了判定に流れる**ところだった。修正: **`Shell` に `panel={<PanelContent />}`**（**選択 null なら null** で UI 不変）、**build 成果物で worker を assert するテスト**。
- **W-P1 の裁定（lead）**: **250 KB は gzip**（`docs/web-client-nfr.md` に明記。**raw と gzip が混在していて同じ build が pass とも fail とも読めていた**）。**実測: 初期 JS 786,154 B raw / 230.32 KB gzip**、**上限まで 19.7 KB**。**0238 の寄与は +1.63 KB gzip / 約 +3 KB raw**（`PanelContent` と `toGlobalId` の参照だけ。**PDF.js 444 KB と `DocumentPanel` は遅延 chunk**）。**W-P3（≤150 KB gzip）内**。
- **同時に直したもの（lead）**: **`faces-start.test.ts` の赤**（`56036e8`）——**テストの SQLite シムが batch の INSERT を 2 回実行**していた（`UNIQUE constraint failed: trail_changes.id`）＋ **sink の時計（凍結）と metrics の窓（実時計）の不一致**。
- **未接続 / 残件**: ①**`setPreviewSelection` を呼ぶ画面が無い**ので、**ファイルを選ぶ操作からパネルを開く経路はまだ無い**（**器は付いた**）②`setPreviewSelection` は**購読が無いモジュール変数**で、最初の利用者が来たら state / store に置き換える ③**実ブラウザの E2E**（worker が同一オリジンから読まれ、キーボードで操作できる）は **0239** ④`web-node` の実経路は **`npm run check` では skip**（CI に回す仕組みが無い。0239 の E2E で置き換える）⑤`build.test.ts` のコメントが「build を skip する」と書いているが**実装は毎回 build**（実装が正しい）。

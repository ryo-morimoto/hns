# 0238: web に PDF プレビューを置く

status: open
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

- [ ] `pdfjs-dist` を**正確な版で pin** して追加し、worker をバンドルする（CDN を使わない）
- [ ] `ready` で PDF が表示され、ページ送り・ズーム・テキスト選択ができる
- [ ] `queued` / `generating` はスピナー +「準備中」。**1 秒間隔のポーリング**（live は会話専用のため使わない）で切り替わる
- [ ] query の失敗 union（`OfficeFailure`）を扱い、`not_authorized` を文言にする
- [ ] `stale` は「結果を確認中」を出し、alarm の決着後に ready / failed に切り替わる
- [ ] `failed` は code ごとの文言（docs §9）と再試行
- [ ] `unsupported` は理由（形式）を出す。大きさの超過は `failed` + code として出す
- [ ] `disabled` は「Office プレビューは未設定です」＋セットアップ手順
- [ ] `bytes` > 50 MiB または 300 ページ超は PDF を読み込まずに案内を出す
- [ ] キーボードでページ送り・ズーム・パネルから抜けられる

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

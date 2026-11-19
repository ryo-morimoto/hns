# プレビュー・派生成果物の設計（既製品の調査）

2026-11-17 / 調査。[office-architecture.md](office-architecture.md) §6.1 の「置き場 A/B/C」を既製品の設計で判定する。
対象は「Office 文書のプレビュー／派生（PDF・画像・サムネイル）を、どこに・どのキーで・誰の寿命で持ち、どう配信するか」。

## 0. 結論 — 既製品は 5 点で収束している

1. **派生は文書ストアの外に置く。** WOPI/Collabora は実体を持たず、ONLYOFFICE は作業コピーを専用キャッシュへ、
   Box は版ごとの別ストア、Nextcloud はユーザー領域の外（appdata）に置く。DSH の office-kit は
   「ワークスペースに一切書かない」と明記。
2. **キーは「版 + 種別 + パラメータ」。** 内容ハッシュを鍵にする実装は少ない（版 ID・fileId・key が主流）。
3. **寿命はサーバが消す。** TTL（24 時間〜7 日）・LRU・サイズ上限・定期ジョブ。「ユーザーが消す」設計は無い。
4. **URL を capability にしない方向。** Microsoft は tempauth を 2027-04 に廃止、Box は Bearer 必須、
   ONLYOFFICE は 15 分署名。URL 単体で読めるのは Collabora のプレビュー画像（tag）程度。
5. **API は同期 or ジョブ（待ち/処理中/完了/失敗の閉じた状態）。** 巨大文書は**ページ単位**（Box paged・Graph page）
   か、**上限で拒否**（Nextcloud 4096px、Seafile 50MB）。

→ hns の **B（machine のキャッシュ）が既製品の収束点**。A は「Nextcloud 型」だが、置き場がユーザー領域の外にある点が違う。

## 1. エディタ型（実体を持たない）

| | WOPI / Collabora | ONLYOFFICE |
| --- | --- | --- |
| 保存場所 | ホストが実体を持つ。エディタは GetFile/PutFile で往復 | 作業コピーを cache storage（`App_Data/cache/files`、S3/Azure 可） |
| キー | ファイル ID + `Version`（内容が変われば必ず変わる・再利用不可） | 呼び出し側の `key`（128 字）。既知 key はキャッシュから返す |
| 寿命 | 規定なし（ロックだけ 30 分） | 最終オープンから 24 時間。毎時 cron が 100 フォルダずつ削除。開いている文書と未保存は残す |
| 認可 | `access_token` を URL に、`access_token_ttl`（ms epoch、10 時間推奨） | 設定・callback は JWT、キャッシュ URL は 15 分署名 |
| API | 同期 REST。PutFile は `X-WOPI-Lock` 必須、不一致は 409 + 現ロック | callback は非同期 POST（1/2/3/4/6/7）に `{"error":0}` で応答 |
| 巨大文書 | `Size` を宣言。EnumerateChildren はページング無し | 表計算→PDF/画像は 1500 ページまで。サムネイル 100px |

Collabora はプレビューを `GET /cool/preview`（索引 JSON）→ `/cool/preview/<tag>/content`（画像）で返し、
**tag が capability**。キャッシュは 1440 分 / 1024 MB / LRU。トークン失効時は postMessage で更新を要求し、60 秒で read-only。
（[WOPI concepts](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/concepts),
[CheckFileInfo](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/files/checkfileinfo/checkfileinfo-response),
[ONLYOFFICE data retention](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/data-retention)）

## 2. SaaS 型

| | Box | Dropbox | Microsoft Graph |
| --- | --- | --- | --- |
| 置き場 | 版ごとの別ストア（URL に file id / version id を含む） | 公開せず（実質ステートレス） | サムネイルは item 配下の `ThumbnailSet`、preview は opaque URL |
| キー | 版 ID + 種別 + `dimensions` + 透かし | path（`rev:` 可）+ format + size + mode | 固定枠（small/medium/large/source）+ custom size |
| 寿命 | 版が変われば URL が変わる（自然失効）。公開なし | 公開なし | URL の寿命は tempauth 廃止で「Authorization 必須」へ |
| 認可 | `Authorization: Bearer` 必須。埋め込みは **1 分**で失効 | —— | preview URL は**呼び出し元の権限で描画**＝URL が capability |
| 巨大文書 | **paged PDF**（`3.pdf` でページ単位） | 20MB 超の写真は作らない | `page`/`zoom` を受ける（ビューア依存） |

（[Box representations](https://developer.box.com/guides/representations/request-a-representation),
[Graph preview](https://learn.microsoft.com/en-us/graph/api/driveitem-preview?view=graph-rest-1.0),
[tempauth 廃止](https://devblogs.microsoft.com/microsoft365dev/pre-authenticated-tempauth-urls-are-retiring-move-to-microsoft-entra-id-tokens-before-april-1-2027/)）

## 3. セルフホスト型

| | Nextcloud | Seafile | ownCloud |
| --- | --- | --- | --- |
| 置き場 | `appdata_<id>/preview/<md5(fileId)[:7]>/<fileId>/` + DB `oc_previews` | `seahub-data/thumbnail`（13.0 以降は別コンテナ） | `data/<user>/thumbnails` |
| キー | fileId + 幅高さ + crop/mode + mime + previewVersion | 内部 | 内部 |
| 寿命 | `preview_expiration_days` 既定 **0（無期限）**、毎時の BackgroundCleanupJob、`occ preview:cleanup` | 内部 | 内部 |
| 認可 | ログインセッション / 共有は `/publicpreview/{token}` | thumbnail server が Seahub に問い合わせ（JWT + 内部 URL） | セッション |
| 上限 | 4096px・画像 50MB・256MB メモリで代替アイコン。**Office/PDF のプレビューは既定で無効** | 画像 256MB 超は拒否、PDF 50MB 超かつ 1 ページ 800 万 pt 超は不可 | 2048px・50MB・原寸 6016x6016 |

（[Nextcloud LocalPreviewStorage](https://github.com/nextcloud/server/blob/master/lib/private/Preview/Storage/LocalPreviewStorage.php),
[BackgroundCleanupJob](https://github.com/nextcloud/server/blob/master/lib/private/Preview/BackgroundCleanupJob.php),
[Seafile thumbnail server](https://manual.seafile.com/latest/extension/thumbnail-server/)）

**読み**: 「ユーザーのファイル空間の外（appdata）に一元的に置き、版キーで別物にし、サーバのジョブが消す」が
セルフホスト製品の答え。hns の B はこれの「machine 側」版。

## 4. 変換サービス型

| | Gotenberg | CloudConvert | Aspose Cloud |
| --- | --- | --- | --- |
| 置き場 | **ステートレス**（応答後に消す） | 自社に一時保存 or S3 へ直接 | Storage 上の元ファイル、`outPath` 指定時だけ保存 |
| キー | なし（毎回変換） | ジョブ/タスク名 | パスの名前空間 |
| 寿命 | —— | **24 時間**（タスクも URL も） | 既定 30 日以上（保持ルールで削除） |
| API | 同期 multipart 200、webhook なら 204 | job: waiting/processing/finished/error + webhook | 同期・非同期の両方 |
| 巨大文書 | タイムアウトで打ち切り、stage で部分出力 | プラン依存 | —— |

（[Gotenberg](https://gotenberg.dev/docs/about), [CloudConvert](https://cloudconvert.com/docs/import-export/export-files),
[Aspose retention](https://about.aspose.cloud/legal/file-retention-policy)）

## 5. 同型プロダクトの参照実装（DSH office-kit）

- **ワークスペースには一切書かない**。`outputDirectory` の下に**所有者（Session）だけが読める**ディレクトリを作り、
  `session-<24 hex>/<uuid>/` に保存して絶対パスを返す。
- 削除は 4 契機: TTL（24 時間）・容量超過（512 MB、古い順）・Session 破棄・provider の unload。削除失敗は記録して再試行。
  起動時に**前プロセスの期限切れディレクトリ**を掃除する（名前の形で判別）。
- プレビューは PDF をそのままクライアントへ返す（multipart）。キャッシュはメモリ 8 件 / 128 MB、
  キーは **engine の世代 + 拡張子 + ソース内容の同一性**。読み取りのたびに認可と版を確認する。
- ソースと PDF のバイト列は Session ストレージに入れない。

## 6. hns への当てはめ

| 決定 | 内容 | 根拠（既製品） |
| --- | --- | --- |
| 置き場 | **B: machine のキャッシュ**（`~/.cache/hns/office/<workspaceId>/<pathHash>/<version>/<op>-<params>.<ext>`） | DSH・Nextcloud（ユーザー領域の外）・ONLYOFFICE（専用キャッシュ） |
| キー | **版（workspace の版）+ 操作 + パラメータ**（pages/dpi/width） | WOPI の Version、Box の版 ID、Nextcloud の fileId+params |
| 内容ハッシュ | 重複排除にだけ使う（同一内容の別パスを共有） | DSH のソース同一性 |
| 寿命 | TTL 7 日 + サイズ上限 2 GB + LRU。**起動時に旧プロセスの残骸を掃除** | DSH（24 時間/512 MB）、OnlyOffice（24 時間 cron） |
| 配信 | **GraphQL のストリーム（Session 認可）**。署名 URL を作らない | WOPI（トークン）、Box（Bearer）、Microsoft の tempauth 廃止 |
| 状態 | `unsupported / disabled / queued / generating / ready / failed` の閉じた union | Box の status.state、CloudConvert の job 状態 |
| 巨大文書 | プレビュー PDF は **50 MB / 300 ページ**まで。超えたら `unsupported` + 理由 | Nextcloud/Seafile の上限、Box の paged |
| ユーザーの PDF | **通常のワークスペースファイル**（キャッシュに入れない） | Aspose の `outPath`（明示時だけ保存） |

## 7. 未確定

- WOPI の lock（30 分）と hns の版競合（`expectedVersion`）をどう揃えるか（編集は P1 の話）。
- プレビュー PDF の 50 MB 上限が実務で足りるか（日本語 150 ページで 1.2 MB なので余裕。図版が多い文書で要確認）。
- machine のキャッシュを**複数マシンで共有**する要求が出たとき（そのとき C を再検討）。

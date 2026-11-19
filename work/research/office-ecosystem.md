# Office 操作のエコシステム調査（agent-native × 安定性）

2026-11-17 / 調査。[Office 操作機能の成立条件](office-capability.md) と [Claude の実装](claude-office.md) の続き。
「エージェントが Office 文書を操作する」領域の競合製品・OSS を、**agent-native 度**と**安定性**の 2 軸で洗った。
枯れていない新興も対象に含める（ユーザーの指定）。数値は 2026-11-17 時点の GitHub / shields.io / 公式 docs。

## 0. 結論

**単一の勝者は無い。3 層に分けて、層ごとに勝者を採る。**

| 層 | 第一候補 | 代替 | 決め手 |
| --- | --- | --- | --- |
| 変換・描画・再計算 | **LibreOffice を自前キューで直列化**（運用則は Gotenberg から借りる） | Gotenberg（MIT, HTTP）, JODConverter（Java） | 形式行列・再計算・PDF/画像。枯れている。SaaS 安全（MPL） |
| 読み取り | **markitdown**（MIT, 196k★, 書込なし） | docling（71k★, レイアウト/表） | 破壊的経路が構造的に無い＝安全 |
| 編集（エージェント面） | **OfficeCLI**（Apache-2.0, 33.4k★, CLI+JSON+MCP） | excel-mcp-server（MCP, 4.3k★）/ Python OOXML ライブラリ | パス DOM・型付きエラー・原子バッチ。テストはゼロ |

**「枯れていないもの」を採る条件は 3 つ**。① 上限とページングが数値で宣言されている、② エラーが型付きで自己修正の材料になる、
③ クラッシュ・破損から隔離できる（別プロセス or 別ファイル）。この 3 つが設計に入っている新興は、実績の代わりに使える。
OfficeCLI（無テストだが 160+ リリース・issue 消化が速い）と excel-mcp-server（golden test 群）はこの条件を満たす。

**2026-11-17 追記**: ユーザー判断（MS 互換を business の武器にする）により、変換・編集の第一候補を
LibreOffice から **ibisOffice（engine pack）** へ変更した。設計・ライセンス・スパイクは [ibisoffice-integration.md](ibisoffice-integration.md)。
この文書の比較表は「エンジンを交換可能にする」前提の材料として残す。

## 1. 評価軸

**agent-native（7 項目）**: ① パス/範囲の一貫した引数（`/Sheet1/A1`、`A1:D20`、`/slide[1]/shape[2]`）
② JSON の封筒（成功/失敗の形が固定）③ 機械可読なスキーマ・help ④ 型付きエラー + 修正提案
⑤ 上限・ページング（セル数・行数・ファイルサイズ）⑥ 原子性（batch のロールバック、atomic save）
⑦ exec 1 回で完結する（常駐を強制しない）

**安定性（6 項目）**: ① テストと CI ② リリース頻度と後方互換 ③ クラッシュ分離と再起動
④ メモリ・zip 爆弾・巨大画像の上限 ⑤ 既存ファイルの保持（未対応要素を壊さない）⑥ データ破損 issue の有無

## 2. 全体マップ

### 2.1 変換・描画の基盤

| 製品 | 言語 | ライセンス | ★ | 最終 | 公開面 | 安定性の要点 |
| --- | --- | --- | --- | --- | --- | --- |
| [Gotenberg](https://github.com/gotenberg/gotenberg) | Go + LibreOffice | MIT | 13.6k | v9.6.0 (11-16) | HTTP のみ | LO は同時 1 文書、10 回で再起動、メモリ超過で kill→422、zip 上限 1 万 / 比 100、429 でキュー拒否、`Gotenberg-Trace` |
| [JODConverter](https://github.com/jodconverter/jodconverter) | Java | Apache-2.0 | 1.6k | 5.1.1 (10-15) | ライブラリ + CLI | プロセスプール、`taskExecutionTimeout` 120s で kill、`maxTasksPerProcess` 200 |
| [libreoffice-kit](https://www.npmjs.com/package/@deepseek-ai/libreoffice-kit) | TS/Node (LOK) | MPL-2.0 | 223 | 0.2.3 (10-27) | Node API | 型付き戻り値・timeout・キャンセル・`missingFonts`。**プロセス内＝クラッシュ分離なし** |
| [ONLYOFFICE DocumentServer](https://github.com/ONLYOFFICE/DocumentServer) | C++/Node | **AGPL-3.0** | 7.1k | v10.0.0 (10-12) | HTTP + x2t CLI | 変換 API は良いが、Postgres/RabbitMQ/Redis 前提。SaaS はソース提供義務 |
| [Collabora Online](https://github.com/CollaboraOnline/online) | C++/JS | MPL-2.0 | 3.4k | Helm 週次 | WOPI (coolwsd) | エディタ主目的。変換専用 API は公開 repo から確認できず |
| [zetajs](https://github.com/allotropia/zetajs)（LibreOffice WASM） | JS | MIT（wrapper） | 230 | v1.2.0 (2025-06) | JS API | 低頻度。単一 WASM プロセスで隔離なし。本体は商用 |
| [unoconv](https://github.com/unoconv/unoconv) | Python | GPL-2.0 | 2.7k | **archived (2023-04)** | CLI | 不採用（反面教師） |

### 2.2 MCP サーバー

| 製品 | 言語 | ライセンス | ★ | 最終 | agent-native | 安定性 |
| --- | --- | --- | --- | --- | --- | --- |
| [excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) | Python | MIT | 4.3k | v2.3.2 (11-16) | ◎ `path`+`sheet`+`range`、`next_range` でページング、1 問題 1 行のエラー整形、`--tools` で面を縮退、`--read-only`、`--allow-dir` | ○ 3 OS × 4 Python で CI、fuzz・cell_budget・**calc_parity**・formula_golden（実 Excel 2,500 式）・pivot_golden |
| [markitdown](https://github.com/microsoft/markitdown) | Python | MIT | 196k | 0.1.9 (10-21) | ○ ツール 1 個（`convert_to_markdown(uri)`） | ◎ 書込が無い＝破損経路が無い |
| [docling](https://github.com/docling-project/docling) | Python | MIT | 71k | v2.150.1 (11-14) | △ MCP + CLI + HTTP | △ 変換失敗が型付きにならない issue が open |
| [ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) | TS | MIT | 1.1k | v0.185.0 (11-14) | ◎ 300+ ツールを宣言的 JSON、`--preset`/`--enabled-tools`/`--read-only`、権限を機械可読に | ○ 起動時に権限境界を計算して失敗 |
| [google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | Python | MIT | 3.5k | v2.5.0 (11-14) | ○ Sheets 14 ツール、`X-MCP-Toolsets` で面を可変 | ○ ファイルサイズ上限を明示 |
| [ppt-mcp](https://github.com/ykuwai/ppt-mcp) | Python (COM) | MIT | 127 | v3.2.0 (11-10) | ○ 157 ツール、対象を 1 ファイルにロック | △ 生きた PowerPoint 必須。`RPC_E_CALL_REJECTED` を 15 秒リトライ |
| [Office-Word-MCP-Server](https://github.com/GongRzhe/Office-Word-MCP-Server) / [PowerPoint](https://github.com/GongRzhe/Office-PowerPoint-MCP-Server) | Python | MIT | 2.1k / 1.9k | **archived (2025-12)** | △ ツール分割の語彙は参考 | ✗ テスト無し、Word にパストラバーサル未修正 #93 |

### 2.3 OOXML ライブラリ

| ライブラリ | 言語 | ライセンス | ★ | 最終 | 往復（既存編集） | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| [excelize](https://github.com/qax-os/excelize) | Go | BSD-3 | 21k | v2.11.1 | ○（保持範囲は要実測） | 依存 8,697 repos。ストリーミングで大規模に強い |
| [python-docx](https://github.com/python-openxml/python-docx) | Python | MIT | 5.8k | 1.2.0 (2025-06) | ○（lxml 保持） | 描画なし。更新は年単位 |
| openpyxl | Python | MIT | — | 3.1.5 (2024-06) | △ **shapes を保存で失う**（docs 明記） | Heptapod に移転。再計算なし |
| [python-pptx](https://github.com/scanny/python-pptx) | Python | MIT | 3.6k | 1.0.2 (2024-08) | △ | レイアウト計算なし。更新は鈍い |
| [docx-js](https://github.com/dolanmiu/docx) | TS | MIT | 6.0k | 9.15.4 (11-14) | ○ `patchDocument`（段落単位） | CI + codecov、週次。**Claude の docx 生成はこれ** |
| [exceljs](https://github.com/exceljs/exceljs) | JS | MIT | 15.5k | **4.4.1 (2024-01)** | △ | 2 年リリース無し。pivot に制限 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | TS | MIT | 6.4k | 4.0.1 (2025-06) | ✗ 生成専用 | Claude の pptx 生成 |
| [rust_xlsxwriter](https://github.com/jmcnamara/rust_xlsxwriter) | Rust | MIT/Apache | 602 | 0.102.0 (11-15) | ✗ 生成専用 | README が明記。月次 |
| [docx-rs](https://github.com/bokuweb/docx-rs) | Rust/WASM | MIT | 563 | 0.4.21 | △ read→JSON、ZIP 名衝突を拒否 | 「support is not exhaustive」 |
| [umya-spreadsheet](https://github.com/MathNya/umya-spreadsheet) | Rust | MIT | 495 | 4.0.0-beta.1 | △ | beta でエラー型刷新中 |
| [Apache POI](https://github.com/apache/poi) | Java | Apache-2.0 | 2.3k | 6.0.0 | ○ `FormulaEvaluator` で再計算 | メモリ重。描画なし |
| [docx4j](https://github.com/plutext/docx4j) | Java | Apache-2.0 | 2.4k | 17.3.6 | ○ PDF 出力でページ割り | JAXB で重い |
| [Open XML SDK](https://github.com/dotnet/Open-XML-SDK) | C# | MIT | 4.6k | 3.5.1 (08-18) | ○ `OpenXmlValidator` | 低レベル。再計算・描画なし |
| Aspose / Syncfusion / Spire | 商用 | — | — | — | ◎ 再計算エンジン + PDF | 価格。Syncfusion は小規模無償 |

### 2.4 エージェント特化の製品

| 製品 | 言語 | ライセンス | ★ | 最終 | 公開面 | 評価 |
| --- | --- | --- | --- | --- | --- | --- |
| [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | C# (.NET 単一バイナリ) | Apache-2.0 | **33.4k** | v1.0.162 (11-16)、通算 160+ | CLI + JSON + stdio MCP + SDK | **設計は最良、テストはゼロ**（後述） |
| Claude の docx/xlsx/pptx スキル | Python | Apache-2.0（2026-11-06 に移行） | 196k | 11-16 | 手順 + スクリプト | 検証ループの参照。型付きエラー・常駐は無し |
| Google Sheets MCP（公式） | — | — | — | — | MCP 6 ツール | 範囲指定は型付き。書式は苦手 |
| Quadratic | TS (SaaS) | 非公開 | — | — | **ホスト型 MCP** | セルフホスト不可 |
| Equals | SaaS | 非公開 | — | — | ホスト型 MCP + REST | 書込面が薄い |
| Rows | SaaS | 非公開 | — | — | REST（60 req/min） | Superhuman に吸収。先行き不透明 |

**この領域の構図**: 「ローカルで完結し、エージェントが直接叩ける」製品は OfficeCLI がほぼ唯一。
SaaS 勢（Quadratic / Equals / Google）は**リモート MCP をホストする**方向に寄っており、セルフホスト前提の hns とは層が違う。

## 3. 深掘り

### 3.1 OfficeCLI — 設計の完成度が最も高い

- 1-based のパス DOM（`/slide[1]/shape[2]`、`/Sheet1/A1`）、L1 read → L2 DOM → L3 raw XML の段階。
- `help <format> <element> --json` が **JSON Schema** を返す（`schemas/help/_schema.json`）。エージェントが推測せずに引ける。
- エラーは `{success:false, error:{code, suggestion}}` の 9 コード。`batch` は**既定で原子的**（1 件失敗で全ロールバック）。
- `validate`（OpenXML スキーマ）と `view issues`（オーバーフロー検出）、終了コード 2 =「適用したが警告」の三分法。
- 常駐は named pipe、idle で自動 flush。MCP モードでは `OFFICECLI_NO_AUTO_RESIDENT=1` が既定（flush 遅延の罠を踏まない）。
- **弱点**: リポジトリにテストが 1 つも無い（workflow は tag push 時のビルドのみ）。
  [#375](https://github.com/iOfficeAI/OfficeCLI/issues/375) 常駐中の外部書き込みを無警告で上書き（lost update、未解決）、
  [#619](https://github.com/iOfficeAI/OfficeCLI/issues/619) 単一セル編集で約 500 MB、[#610](https://github.com/iOfficeAI/OfficeCLI/issues/610) ExcelJS が生成物を開けない、
  `view screenshot` は同梱ブラウザを持たず**システムの Chrome/Edge/Firefox に shell-out**（`--no-sandbox`）。
- **hns での扱い**: 常駐を使わず **exec 1 回 + 明示 save** に固定する。lost update を踏まない。スクリーンショットは使わず、
  描画は LibreOffice 側に寄せる。

### 3.2 excel-mcp-server — 表計算の「守り」の手本

- セル数上限 10 万、ファイル 100 MB、読込セル 300 万。`read_range` は 1 ページずつ返し `next_range` で継続。
- 保存は atomic、既存ブックを暗黙に上書きしない。pydantic の検証エラーを「1 問題 1 行」に整形（`did you mean 'range'?`）。
- CI は 3 OS × Python 3.11〜3.14。**実 Excel の 2,500 式で計算一致を検証**（calc_parity）、ピボット約 200 件の golden。
- **弱点**: 直近も破壊的編集の回帰が続く（2026-11-16 に Power Query の queryTable 消失、11-13 に別シートのコメント消失）。
  .xls 非対応。2.0 でツール名が全変更（後方互換なし）。
- **hns での扱い**: そのまま採用も可。ただし「上限・エラー整形・atomic save・golden test」を**仕様として写す**方が価値が高い。

### 3.3 Gotenberg — 変換の運用則の参照実装

- 同時実行は LibreOffice を 1 文書に直列化。10 回変換したら再起動（メモリリーク対策）、メモリ上限超過で kill → 422。
- zip 爆弾（1 万エントリ / 圧縮比 100）、`--api-timeout` 30 秒、キュー満杯で 429、タイムアウト/クラッシュで 503、`/health`。
- エラーはコード別に型付き（400 = フィールド名と期待値、422 = メモリ、429 = 混雑、503 = エンジン）。
- **弱点**: 日本語フォントを同梱しない（Liberation / Carlito / Caladea のみ）。出力は PDF 中心で xlsx の書き戻しは不可。
- **hns での扱い**: サービスとして同梱するより、**運用則（直列化・再起動・上限・コード別エラー）を hns のラッパーに移植**するのが現実的。

### 3.4 libreoffice-kit — TS スタックに最短距離

- Node から LibreOfficeKit を直接叩く。`createConverter({timeoutMs})`、`render`・変換・再計算、`missingFonts` 返却、キャンセル、資源上限、
  native → WASM のフォールバック。MPL-2.0。npm 0.2.3（2026-10-27）。
- **弱点**: 0.2.x で実績が浅い。プロセス内実行なので**クラッシュ分離が無い**（壊れた文書 1 つでプロセスが落ちる）。
- **hns での扱い**: machine の Node プロセスに同居させるなら有力。ただし変換だけは別プロセスに逃がす（worker_threads では不十分）。

### 3.5 Claude のスキル — 検証ループの参照

- `validate.py`（XSD 検証。`--original` で redline 漏れ検出、`--auto-repair`）、`soffice.py`（svp・一時プロファイル・LD_PRELOAD シム）、
  `recalc.py`（StarBasic マクロで `calculateAll()`）、`merge_runs.py`（run の fragmentation を吸収）。
- **弱点**: 型付きエラー・常駐・スキーマが無い。手順書依存。
- **hns での扱い**: 「作成 → 検証 → PDF → 画像 → 読む」をツール契約に埋め込む際の手本。

## 4. 安定性ティア

| ティア | 意味 | 該当 |
| --- | --- | --- |
| **A（枯れている）** | 多年の実績・後方互換・運用則が確立 | Apache POI, Open XML SDK, LibreOffice, Gotenberg, excelize, JODConverter, ONLYOFFICE/Collabora |
| **B（設計で守っている）** | 実績は浅いが、上限・型付きエラー・隔離が設計に入っている | OfficeCLI, excel-mcp-server, docx-js, docx-rs, rust_xlsxwriter, markitdown, docling, libreoffice-kit |
| **C（停滞・危険）** | 更新停止、既知の破損、アーカイブ | unoconv, exceljs, Office-Word/PowerPoint-MCP（archived）, Zerox, olmOCR, zetajs |

**B を採る条件**（§0 の再掲）: 上限制・型付きエラー・隔離の 3 点。加えて hns 側で
「出力を必ず再オープンして検証する」「描画して目視する」を契約に入れれば、実績の不足は運用で補える。

## 5. hns の推奨構成

```
machine (bwrap)
  ├─ 変換・再計算・描画: soffice を別プロセスで起動（hns のキュー）
  │    直列 1、N 回で再起動、メモリ上限、timeout、zip 上限、コード別エラー、trace id
  ├─ 読み取り: markitdown（docx/xlsx/pptx → Markdown）/ 必要なら docling
  ├─ 編集: OfficeCLI（exec 1 回・cold・明示 save）
  │    代替: excel-mcp-server（xlsx）/ python-docx・python-pptx（docx/pptx）
  └─ 検証: 再オープン + XSD（validate）+ PDF → PNG で目視
```

**採用順（hns の Phase A に落とすなら）**

1. **soffice ラッパー**（Gotenberg の運用則 + Claude の soffice.py の sandbox 対策）。これだけで変換・画像化・再計算が埋まる。
2. **markitdown**（読取）。書込が無いので事故らない。
3. **OfficeCLI を編集の第一候補**に据えて、bwrap 適合と日本語を実測。ダメなら python ライブラリへ。
4. **excel-mcp-server の仕様**（上限・エラー整形・atomic save）を hns のツール契約に写す。

## 6. 採用しない・注意

- **unoconv**: archived（最終リリース 2017）。キューも timeout も無い。
- **Office-Word/PowerPoint-MCP-Server**: archived（2025-12）。Word 側にパストラバーサル未修正。
- **exceljs**: 2024-01 からリリース無し。pivot に制限。
- **ONLYOFFICE**: AGPL-3.0。SaaS でソース提供義務。フル構成は Postgres/RabbitMQ/Redis 前提。
- **SaaS のリモート MCP**（Quadratic / Equals / Google）: セルフホスト不可。hns の bwrap 内には置けない。
- **Rows**: Superhuman に吸収。先行き不透明。
- **OfficeCLI の常駐・screenshot**: lost update（#375）と外部ブラウザ依存。使わない。

## 7. 追加の検証スパイク

| # | 問い | 合格ライン |
| --- | --- | --- |
| S8 | OfficeCLI は bwrap 内で動くか（.NET 単一バイナリ、日本語） | cold exec 1 回で編集・保存できる。500 MB 級メモリが出ない |
| S9 | OfficeCLI で作った docx/xlsx を LibreOffice が正しく描画するか | PDF の画素比較で致命的差なし |
| S10 | excel-mcp-server の上限・エラー整形を自前実装に写せるか | 同じ入力で同じ code が返る |
| S11 | soffice + 日本語フォント（Noto CJK / IPAex）で PDF の字送りが合うか | MS Office の PDF と行送りが一致 |

## 8. 未確認

- OfficeCLI の冪等性・同時編集ロックの実装（#375 未解決）、private CI のテスト有無。
- LibreOffice 系 MCP は事実上不在（★186 のアプリ 1 件のみ）— ここは空白地帯。
- Gotenberg が CJK を実際に描画できるか（同梱物の一次記載なし）。
- Collabora の変換専用 CLI（`coolconvert`）の有無。
- openpyxl の ★ / commit（Heptapod のため GitHub メトリクスが無い）。
- 商用（Aspose / Syncfusion / Spire）の MCP・CLI 提供状況。

## 9. 出典

- 変換: gotenberg.dev（route / errors / production / troubleshooting）、JODConverter の local-manager doc、npm libreoffice-kit、
  zetajs README、ONLYOFFICE Conversion API、CollaboraOnline/online
- MCP: 各リポジトリの README・CI・issue（excel-mcp-server の v2.3.2 と golden test、markitdown、docling、ms-365-mcp-server、
  google_workspace_mcp、ppt-mcp）
- ライブラリ: 各リポジトリの README / release / docs（openpyxl の shapes 制限、docx-js の patchDocument、docx-rs、excelize）
- 製品: OfficeCLI の README・help schema・McpServer.cs・issue #375 / #619 / #610、Anthropic skills の LICENSE 移行（#2146）、
  Quadratic / Equals / Rows の docs、Google Sheets MCP
- ★ と最終更新: shields.io（2026-11-17 取得）

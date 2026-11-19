# Office 操作機能の成立条件 — ibisOffice / LibreOffice の調査

2026-11-17 / 調査。対象は **hns**（DSH ではない）。DSH 同梱の office-kit は「既に本番で動いている参照実装」として扱う。
調査は 3 本（ibisOffice / LibreOffice / 参照製品）に分け、一次情報（公式ドキュメント・リポジトリ・ソース）で確認した。
確認できた事実には出典を付け、推測は「推測」と書く。
競合・エコシステムの全体像は [office-ecosystem.md](office-ecosystem.md)、Claude の実装は [claude-office.md](claude-office.md)。

## 0. 結論

1. **「Office を操作する」は 1 つの機能ではない。** 読む・書く・変換する・見る（画像化）・再計算する、の 5 用途の束で、
   用途ごとに最適な実装が違う。1 エンジンで全部を賄う選択肢は、今日の候補の中に無い。
2. **今日の hns に入れるなら、変換・再計算・画像化は LibreOffice ヘッドレス、著述・編集は Python の OOXML ライブラリ**
   （python-docx / openpyxl / python-pptx）。ライセンスは MPL-2.0 / MIT で、別プロセス実行なら hns のソース公開義務は生じない。
3. **ibisOffice は「表示の忠実度と速度」で最有力だが、今日の形では操作インターフェースが無い。**
   CLI は PDF/PNG の書き出し専用、Rust クレートは `publish = false`（crates.io 未公開）、HTTP/MCP は #159 の提案のみ。
   AGPL-3.0-only に加えて §7(b) の「Powered by ibisOffice」表示義務があり、SaaS 提供時の §13 も効く。
   **中核エンジンではなく、Phase C の「レンダラ」比較対象として残す**のが妥当。
4. **第三の選択肢 OfficeCLI**（Apache-2.0・単一バイナリ・エージェント向け CLI）は、著述・編集の層で
   python ライブラリ路線の上位互換になり得る。評価コストが低いので、Phase A の比較に 1 日だけ足す価値がある。
5. **実行場所は machine（利用者のマシン）で、bwrap sandbox の内側。** Worker には置けない（プロセスを起動できない）。

### 0.1 アイデアの判定

| アイデア | 判定 | 理由 |
| --- | --- | --- |
| hns に「Office を操作する」能力を入れる | **成立** | Phase A は machine のイメージ + skill + ラッパーで足りる。主コストは LibreOffice の同梱とフォント、敵対ファイル対策 |
| ibisOffice を中核エンジンにする | **今日は不成立** | 操作 API が無い（CLI は書き出し専用、クレート未公開、MCP は未実装）。AGPL §7(b)/§13 の判断も要る |
| ブラウザで文書を編集する | **不成立（今は）** | hns の web はテキストエディタ。WASM エディタは 0010 で parked。ibisOffice WASM は 65 MB + WebGPU 必須 |
| OfficeCLI を編集層に使う | **条件付き** | 設計は最もエージェント向け。ただし .NET 単一バイナリの追加と、忠実度・再計算の実測が要る |

## 1. 前提 — hns のどこに載るか

| 事実 | 出所 | Office 機能への含意 |
| --- | --- | --- |
| machine agent が ROOT を持ち、exec は bwrap 経由（0194） | `packages/machine/README.md`, `work/issues/0194` | エンジンは machine のイメージに入れる。Worker には置けない |
| 現行 op は health / stat / read / list のみ、write / exec は未実装 | 同上 | 変換・描画を「ツール」にするなら op の追加が要る |
| ToolId は `read_file` / `write_file` / `bash` の閉集合（D091） | `docs/capability.md` | Office を第一級ツールにするなら契約の拡張と grant の発行が要る |
| machine の応答上限は既定 256 KiB、RPC は 30 秒 | `packages/machine/src/limits.ts` | PDF/PNG を応答で返せない。**ワークスペースに置いてパスを返す** |
| sandbox では root だけが書き込み可（他は ro-bind） | `packages/workspace/src/sandbox.ts` | `--ro-bind / /` + root の bind。soffice・フォントは ro で見え、出力は root に書ける |
| `--dev` は最小 /dev（**/dev/dri は無い**）、`--clearenv`、`HOME=root`、`--tmpfs /tmp` | 同上 | GPU は sandbox 内で使えない。プロファイルは HOME 配下に置く |
| ネットワークは未隔離（unshare は pid/ipc/uts のみ） | 同上 | 外部リンク参照型の文書は外向き通信を起こし得る。Office 実行だけ netns を切る追加が要る |

この 7 行が、以下の設計をほぼ決めている。**「エンジンを選ぶ」問題の前に、「どの層で・誰の権限で動かすか」が制約になる。**

## 2. 対象のインターフェース（一次情報）

### 2.1 LibreOffice

**実行モデル**

- `soffice --headless --convert-to EXT[:Filter[:JSON]] --outdir DIR file...`。
  **1 回の起動で指定できる出力形式は 1 つ**（複数指定すると最後だけ有効）だが、複数入力は一括変換できる。
  （[start parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)）
- フィルタは API 名（`writer_pdf_Export`、`"MS Word 2007 XML"` 等）。PDF・画像は JSON パラメータ
  （PageRange / SelectPdfVersion / PixelWidth）を取る。
  （[convertfilters](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html)）
- **プロファイルに書き込み権限が必須**。`-env:UserInstallation=file:///path` で分離する。
  `--nofirststartwizard` は「何もしない（後方互換のみ）」ので、セキュリティ対策として数えない。
- 常駐させるなら UNO（`--accept=pipe,...;urp;` + pyuno）か LOK（C API: `lok_init` / `documentLoadWithOptions` /
  `paintTile` / `setPart`）。公式 README は LOK の用途を「文書変換と（実験的）タイル描画」と書く。
  （[LOK](https://docs.libreoffice.org/libreofficekit.html)）
- 常駐系の実装は枯れていない。**unoconv は 2023-04 にアーカイブ**、JODConverter 5.1.1 の既定は
  `maxTasksPerProcess=200` / `processTimeout=120s` で、「0（無制限）はメモリリークがあるので非推奨」と明記。
  gpg 子プロセスのゾンビ化（[#439](https://github.com/jodconverter/jodconverter/issues/439)）、
  リスナ劣化で再起動する運用（[gotenberg#406](https://github.com/gotenberg/gotenberg/issues/406)）が既知。

**忠実度・再計算**

- 未導入フォントは Liberation 系で代替（Arial→Liberation Sans 等、メトリック互換）。
- **再計算の既定は「しない」**: officecfg の `OOXMLRecalcMode` は既定 `1`（Recalc never）。
  → **ヘッドレス変換は Excel のキャッシュ値をそのまま PDF 化する。**
  （[Calc.xcs](https://raw.githubusercontent.com/LibreOffice/core/master/officecfg/registry/schema/org/openoffice/Office/Calc.xcs)）
  「数式を評価して値にする」用途は、この既定を変えるか UNO で明示的に再計算する必要がある。

**配布・サイズ**

- 公式は deb / rpm / Flatpak / Snap / AppImage / Portable。**公式 Docker イメージは無い**（`collabora/code` は CODE）。
- Debian trixie の nogui 構成で約 **219 MB**（core-nogui 107.3 + common 48.6 + writer-nogui 30.2 + calc-nogui 26.9
  + impress-nogui 2.2 + ure 4.3）。日本語は fonts-noto-cjk 91.2 MB / fonts-ipafont-gothic 12.2 MB。
- 現行版は 26.8.3（26.2.7 併存）。

**セキュリティ**

- 既定: `MacroSecurityLevel=2`、`DisableMacrosExecution=false`、`DisableActiveContent=false`、
  `DisablePythonRuntime=false`、外部リンク遮断も**既定オフ**。明示的に締めないと開く。
- アドバイザリは継続的に出ており（6.4 系から現行まで 70 件超）、直近の傾向は「文書を開く」「コマンドライン引数」
  経由のコード実行。例: `.iqy`（Web クエリ）をコマンドラインで渡すとコード実行（CVE-2026-108169、2026 年）、
  Calc のデータリンク経由で外部の Java ドライバを読む（CVE-2026-104920）、ODF のフォームコントロール取り込み
  （CVE-2026-101892）。いずれも「文書を開かせる」だけで成立する。
  → **信頼できないファイル名・拡張子をそのまま soffice に渡さない**（拡張子を固定し、内容と一致させる）。

**ライセンス**: MPL-2.0（+ Apache-2.0 由来、版ごとに混在）。**別プロセス実行はファイル単位コピーレフトの外**。
改変版を配布するときだけ MPL 対象ファイルの公開義務が生じる。

### 2.2 ibisOffice

**操作手段**

- CLI は `--export pdf|png|pdf-image|ui` と印刷系オプション（`--handout` / `--notes-pages` 等）、
  `--out-dir` / `--width` / `--slides`。**docx→odt/csv のような形式変換コマンドは無い**。
  （[cli-options](https://github.com/ibisjp/ibis-office/blob/main/docs/cli-options-ja.md)）
- Rust API は存在する（`ibis-pptx::save::open` → `Source::save`、編集は `ibis-doc-model` の `Command`。
  未対応の変更は `Err(unsupported)` で失敗し、黙って捨てない）。ただし `publish = false`、**crates.io 未公開**。
- WASM のエクスポートは `run` と `set_embed_options` の 2 つだけ。JS から編集する API は無く、
  保存は `ibisoffice:download` イベントでバイト列を受け取る方式。
- HTTP/JSON API・マクロ・スクリプト無し（マクロは「実行せず保持」）。
- **MCP サーバーは #159 の提案（open）で未実装**。

**忠実度・速度**

- 自社計測（M2 Pro、0.1.0 開発版、各 1 回）: PDF 書き出しで pptx 1.42 s / docx 0.69 s / xlsx 7.26 s
  （LibreOffice は 32.26 / 3.45 / 19.46 s）。「7 万超のテストで Office の PDF と画素比較」と主張。
- 第三者: 窓の杜・GIGAZINE の記事、実機レビュー（レイアウトは概ね一致、ツールバー不具合、テンプレート少）。
- 公開 CI は flatpak の workflow のみ。**テストは公開 CI で回っていない**。

**ライセンス**

- AGPL-3.0-only と商用のデュアル。**NOTICE に §7(b) の追加条件**: 派生物の UI に
  「Powered by ibisOffice」+ リポジトリへのリンク必須。商標は許諾されない。
- §13（ネットワーク提供時のソース開示）は README も明記。商用ライセンスの条件・価格は非公開（問い合わせのみ）。

**既知の制約**

- 保存の未対応操作（文書の変更、グラフの複製）、PDF リンク消失 #227、数式の色 #197、`w14:paraId` 保持 #221、
  偶数ページのセクション区切り #223、脚注記号 #228。
- サーバー版・共同編集はゴール段階。**ヘッドレスで xlsx を再計算する手段は CLI に無い。**

### 2.3 OfficeCLI（参考: エージェント向けに振り切った設計）

- Apache-2.0、単一バイナリ、C#（.NET）実装。`officecli` 1 本で docx/xlsx/pptx の create/get/set/add/remove/query。
- **パス指定の DOM 編集**（`/body/p[1]`、`/Sheet1/A1`、`/slide[1]/shape[1]`）+ `--json` の構造化出力。
- **`help` をスキーマとして返す**（`officecli help docx paragraph`）。エージェントが推測せずに引ける。
- **resident モード**（初回アクセスで自動起動、60 秒アイドルで終了、ファイルロック競合を回避）。
- 型付きエラー（`not_found` / `invalid_path` / `unsupported_property` …）+ 修正提案（`suggestion`）。
- `view html` / `view screenshot`（PNG）を自前の HTML レンダリングエンジンで出す。MCP サーバー内蔵。
- 比較表で LibreOffice を「AI ネイティブ CLI + JSON ✗ / パスベース ✗ / Zero install ✗」と落としている。

### 2.4 参照製品の共通形

公開面は**「文書の所在（URL/ID）＋操作（config / 操作列 / スクリプト）＋結果通知（callback or 応答）」**に収束し、
**レイアウト描画は別プロセス**に置かれる。

| 製品 | 公開面 | 実行モデル |
| --- | --- | --- |
| ONLYOFFICE DocumentServer | `api.js` + config（JWT 署名）、保存は `callbackUrl` への POST（status 1/2/3/4/6/7）、変換は `POST /converter`、生成は `POST /docbuilder` | 常駐サーバ + ブラウザ。Community は AGPL v3 |
| Google Docs API | `batchUpdate`（操作列を原子的に適用）、`requiredRevisionId` で楽観ロック（不一致は 400） | クラウド。UI は別 |
| Microsoft | Office.js はクライアント内のアドイン、Graph はファイルと Excel のみ（3 セッションモード） | 実行モデルが 3 分断 |
| MCP 系（docforge / OfficeMCP / OfficeCLI） | read / write / convert / render を分割、バッチ、画像 base64、段階的開示 | ローカル CLI かローカルサーバ |

**模倣する価値がある 3 点**: 操作列の原子的適用、版による楽観ロック、型付きエラー + 修正提案。
hns は既に「版付き write + expectedVersion」「閉じた失敗 union」を持っているので、用語を合わせるだけで足りる。

### 2.5 参照実装: DSH office-kit（ローカル確認）

DSH 0.2.2-rc.3 の `packages/document/office-kit` + `tool-office` は、まさにこの問題の実装例。

- **3 つのモデル向けツール**: `office_render`（PNG）/ `office_convert`（形式変換 → 一時ファイルのパスを返し、
  モデルは shell でコピー）/ `office_recalculate`（xlsx/ods）。
- **エンジンは LibreOfficeKit**（`@deepseek-ai/libreoffice-kit`、プラットフォームごとに native か WASM を 1 つ選択）。
- **境界を provider に閉じる**: 同時変換 2、キュー 8、タイムアウト 60 s、入力 50 MB、出力 100 MB、
  アーカイブ展開 1 万エントリ / 250 MB、画像解像度 192 dpi、出力ストア 512 MB / 24 時間、
  フォントのフォールバック表と `missingFonts` の返却、世代（engine/font 交換で無効化）。
- **著述はツールではなくコード**: スキルが python-docx / openpyxl / python-pptx を書かせ、
  `office_render` は「見た目が論点のときだけ」呼ぶ。
- 画像はツール結果に埋め込むが、変換物は**一時ファイルのパス**で返して shell にコピーさせる。

この形（**エンジンは 1 サービスに閉じ、モデル向けは 3 ツール、著述はコード**）は、hns の制約
（応答 256 KiB、Worker でプロセス不可、sandbox は machine 側）とそのまま噛み合う。

### 2.6 参考: Claude の実装（3 経路）

Claude は Office を 1 つの実装で扱っていない（詳細は [claude-office.md](claude-office.md)）。

- **claude.ai のファイル作成**: skills + コードサンドボックス。docx は docx-js、xlsx は openpyxl、pptx は pptxgenjs。
  読みは pandoc / markitdown。**変換と目視は LibreOffice ヘッドレス + pdftoppm**。xlsx の再計算は
  「LibreOffice に StarBasic マクロで calculateAll させる」方式で、--convert-to では再計算されない穴を塞いでいる。
- **Claude for M365**（Excel / Word / PowerPoint / Outlook）: Office.js アドイン。ライブ文書をホストの
  オブジェクトモデルで操作するので、パースも変換も要らない。
- **Google Workspace**（Docs / Sheets / Slides）: Workspace アドオン。Google ネイティブ形式のみ。

hns に移植できるのは 1 番目だけで、これは DSH の office-kit と同型。sandbox 用の soffice ラッパー
（svp / 一時プロファイル / LD_PRELOAD シム / 外部リンク除去）は S1 の下準備として価値がある。

## 3. 用途 × 候補

| 用途 | LibreOffice | ibisOffice | OfficeCLI | Python OOXML |
| --- | --- | --- | --- | --- |
| 読む（テキスト・表・セル） | △（変換経由で遠回り） | ✗（API 非公開） | ○（`get`/`query` + JSON） | ◎ |
| 書く・編集（構造保持） | △（UNO が重い） | ○（Rust API、ただし未公開） | ○（パス指定、未検証） | ○（未対応要素は壊れ得る） |
| 変換（docx→pdf、xlsx→csv、旧形式） | ◎（形式行列が最大） | △（pdf/png のみ） | ○（主要形式、実績浅い） | ✗ |
| 見る（ページ画像） | ◎（PDF → pdftoppm、または LOK） | ◎（高速・高忠実） | ○（HTML/PNG 自前） | ✗ |
| 再計算（xlsx 数式） | ○（既定 off、要設定/UNO） | ✗（CLI 無し） | ○（150 関数） | ✗（`data_only` はキャッシュ） |
| ライセンス | MPL-2.0（安全） | AGPL §7(b)/§13 | Apache-2.0（安全） | MIT/BSD |
| 導入サイズ | 約 220 MB + 日本語フォント 90 MB | AppImage/zip（GPU ドライバ前提） | 単一バイナリ（.NET） | 数十 MB |
| sandbox 適合 | ○（要 profile・/tmp） | ?（GPU 無しで動くか未検証） | ? | ◎ |

## 4. 推奨アーキテクチャ

**層を分ける。エンジンを 1 つに決めない。**

**入れない**（この調査の範囲外）: 共同編集、OnlyOffice / Collabora 級の常駐編集サーバ、ブラウザ内編集
（0010 は parked）、Office の完全なレイアウト再現。hns の成果物は「ファイル」で、UI はテキスト編集のまま。

```
machine (bwrap)
  ├─ 著述・編集  : python-docx / openpyxl / python-pptx（Phase A）→ OfficeCLI を比較（Phase A'）
  ├─ 変換・再計算: soffice --headless（profile 分離・キュー・timeout・zip 検査）
  ├─ 画像化      : PDF → pdftoppm（または PyMuPDF）
  └─ 出力        : ワークスペース内のパス + メタ（サイズ・ページ数・missingFonts）
```

### Phase A（ラッパー + skill だけ。契約を変えない）

- machine のイメージに `libreoffice-nogui` 相当と日本語フォント、Python ライブラリを入れる。
- 薄いラッパー `hns-office`（または skill 内スクリプト）が次を固定する:
  1. `-env:UserInstallation=file://$HOME/.office/<uuid>`（同時実行の衝突回避、終了時削除）
  2. `HOME` 配下の固定プロファイルに `OOXMLRecalcMode=0` などの設定を置く（用途別に 2 プロファイル）
  3. マクロ・ActiveX・外部リンクを締める（`DisableMacrosExecution=true`、`DisableActiveContent=true`、
     外部リンク遮断 ON、`MacroSecurityLevel=3`）
  4. 入力の拡張子を固定（`.docx/.xlsx/.pptx` のみ許可し、内容の magic と一致を確認）。`.iqy` 等は受け付けない
  5. zip のエントリ数・展開後サイズを事前検査（例: 1 万 / 250 MB）
  6. timeout・出力サイズ上限・同時実行数（2）
- ツール面は既存の `bash` のまま。**D091 の契約を触らない**ので、最短で価値が出る。
- 出力はワークスペースに置く。PDF/PNG を応答で返さない（256 KiB 制限）。

### Phase B（第一級ツール）

- machine の op に `convert` / `render` を足す。ToolId `office_convert`（risk: write、scope: roots）。
- 応答は「保存先パス + バイト数 + ページ数 + missingFonts + 生成器の版」。画像はファイルで返す。
- 監査は argsHash（正規化 JSON）に「入力パス・版・出力形式・範囲」を含める。再現性のため生成器の版を残す。
- 失敗は閉じた code（`unsupported_format` / `input_too_large` / `engine_failed` / `timeout` / `missing_fonts`）。

### Phase C（忠実度が必要になったら ibisOffice を測る）

- 条件: (a) #159 のヘッドレス文書サービスが出る、または Rust API を vendoring してよい、
  (b) AGPL §7(b) の表示義務と §13 を hns の配布形態で満たせる（または商用ライセンス）、
  (c) sandbox 内（/dev/dri 無し）でソフトウェア描画のまま実用速度が出る。
- 用途は「レンダラ限定」（PDF/PNG 出力）に閉じる。変換行列と再計算は LibreOffice に残す。

## 5. 検証スパイク（安い順・判定基準つき）

| # | 問い | 方法 | 合格ライン |
| --- | --- | --- | --- |
| S1 | bwrap 内で soffice が動くか | 代表 docx を変換 | 3 秒以内・RSS 500 MB 未満・2 回目も成功 |
| S2 | 忠実度は足りるか | 日本語 5 文書（表・図・ヘッダ・脚注・16:9 スライド）で LO / ibisOffice / OfficeCLI の PDF・PNG を画素比較 | 主要レイアウトの差が許容（人の目で 1 ページ 30 秒） |
| S3 | 再計算は正しいか | `OOXMLRecalcMode` 0/1 で xlsx→pdf、Excel の値と比較 | 既定 off の穴を設定で塞げる |
| S4 | 敵対ファイルで壊れないか | `.docm`、外部リンク、`.iqy`、200 MB 展開の zip、巨大画像 | ネットワーク遮断下で「開かない/落ちる」に留まる |
| S5 | ibisOffice は GPU 無しで動くか | `--export pdf` をコンテナ（/dev/dri 無し・DISPLAY 無し）で | 出力が得られ、時間が実用（1 文書 10 秒未満） |
| S6 | 並列で回せるか | soffice 2 並列 × 10 回 | 失敗 0、時間が 2 倍以内 |
| S7 | ブラウザ内表示は現実的か | ibisOffice WASM（65 MB）+ WebGPU を hns の web で | 初回 5 秒以内、Safari 26 で動く |

## 6. 未確定・リスク

- **ライセンス**: ibisOffice を hns のセルフホスト配布物に同梱する場合、AGPL §13 の「利用者へのソース提供」を
  誰が満たすのか（配布者 = 利用者、なら実質問題にならない）。商用ライセンスの価格・条件は非公開。→ 人に確認。
- **供給**: LibreOffice を machine の前提にする（OS パッケージ or nix）か、同梱するか。hns の導入障壁に直結する。
- **GPU**: ibisOffice のヘッドレスがソフトウェア描画でどこまで速度を保つか未検証（S5）。
- **ネットワーク**: 現行 sandbox は netns を切らない。Office 実行だけ切る（D090 の egress とは別の閉じた実行）。
- **プレビュー**: web にバイナリ文書の表示が無い。WASM エディタ（0010）は parked。PDF/PNG の表示は別 issue。
- **OfficeCLI の実体**: PNG 出力の描画先（内蔵ブラウザか）、再計算の精度、.NET 単一バイナリの sandbox 適合は未確認。
- **LibreOffice の既知の不安定さ**: 変換失敗で終了コード 0 になる報告、プロファイル同時起動、ゾンビ。
  ラッパー側で「出力ファイルの存在と magic を検証」して成功判定する。

## 7. 決定候補（decisions に書くならこの形）

> D0xx: Office 操作は LibreOffice ヘッドレス + Python OOXML ライブラリの 2 層で入れる。
> 変換・再計算・画像化は soffice を別プロセスで動かし（MPL-2.0、bwrap 内、profile 分離、キュー 2、60 秒）、
> 著述・編集は python-docx / openpyxl / python-pptx に任せる。ibisOffice は AGPL §7(b)/§13 と公開 API の
> 不在により、Phase C のレンダラ比較まで採らない。

### 7.1 2026-11-17 の改訂（ユーザー判断）

MS 互換を business の武器にする方針が示されたため、第一候補を ibisOffice に変更する。判断の根拠と設計は
[ibisoffice-integration.md](ibisoffice-integration.md)。

> D0xx': Office 操作はエンジン境界（OfficeEngine アダプタ）を hns 側に置き、**ibisOffice を第一候補**にする。
> 忠実度が問われる PDF/PNG 化・編集・再計算・往復検証は ibisOffice（engine pack、オプトイン配布）に任せ、
> 形式変換（odt/csv/txt/html/doc/xls）とフォールバックは LibreOffice に残す。
> ibisOffice の AGPL は「同梱しない配布」で解く（商用ライセンスの条件を先に確認する）。

## 8. 出典

- LibreOffice: start parameters / convertfilters / pdf_params / graphic_export_params（help.libreoffice.org）、
  LibreOfficeKit（docs.libreoffice.org）、Calc.xcs・Common.xcs（core の officecfg）、
  security advisories（libreoffice.org）、licenses（libreoffice.org）、Debian packages、
  JODConverter docs / issues、unoconv（archived）
- ibisOffice: docs/cli-options.md、docs/web-embedding.md、docs/SECURITY.md、docs/implemented-feature.md、
  Cargo.toml、NOTICE、COMMERCIAL-LICENSE.md、README.md（ベンチマーク）、issue #159
- OfficeCLI: SKILL.md、README_ja.md、リポジトリ構成
- 参照製品: ONLYOFFICE API docs、Google Docs API discovery、Microsoft Learn、MarkItDown / Docling /
  mammoth / python-docx / openpyxl、MCP 系リポジトリ
- 参照実装: DSH 0.2.2-rc.3 の `docs/subsystems/office-kit.md`、`packages/document/office-kit`、
  `packages/skill/skill-office`（ローカル確認、2026-11-17）

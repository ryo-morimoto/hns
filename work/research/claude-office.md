# Claude の Office 実装（docx / xlsx / pptx）— 一次情報

2026-11-17 / 調査。[Office 操作機能の成立条件](office-capability.md) の補足。対象は Anthropic の Claude。
「Claude のスプシや doc は何で実装されているか」を、公開されている実装（リポジトリ・公式ドキュメント）で確認した。
競合・OSS の全体像は [office-ecosystem.md](office-ecosystem.md)。

## 0. 結論

Claude の Office 対応は **1 つではなく 3 経路**ある。実装がまったく違う。

| 経路 | 何で実装 | 動く場所 |
| --- | --- | --- |
| claude.ai の「ファイル作成・編集」 | **skills + コードサンドボックス**。OOXML ライブラリ（docx-js / openpyxl / pptxgenjs）+ pandoc / markitdown + **LibreOffice ヘッドレス**（変換・検証） | Anthropic の隔離コンテナ |
| Claude for M365（Excel / Word / PowerPoint / Outlook） | **Office.js アドイン** | ユーザーの Microsoft 365 アプリの中 |
| Google Workspace（Docs / Sheets / Slides） | **Workspace アドオン**（Extensions メニュー） | ユーザーの Google アプリの中 |

hns に効くのは 1 番目だけ。1 番目は、DSH の office-kit とほぼ同じ設計（ライブラリで書き、LibreOffice で変換・描画する）。

## 1. claude.ai のファイル作成 = skills + コードサンドボックス

- 公式 README が明言: `skills/docx`、`skills/pdf`、`skills/pptx`、`skills/xlsx` は
  **「Claude の文書機能を支えている実装」**で、Apache-2.0 で公開されている。
  （[anthropics/skills README](https://github.com/anthropics/skills)）
- skills の動きは 3 段階: 名前と 1 行説明を見る → 必要なら `SKILL.md` を読む → 指示が指すスクリプトを開く。
  コードは **Claude のコードサンドボックス**で走り、「Code execution と file creation」を ON にする必要がある。
  （[Skills overview](https://claude.com/docs/skills/overview.md)）
- サンドボックスは隔離コンテナで、**ネットワーク egress は組織設定で切れる**。切ると「プリインストール済みパッケージのみ」で動く。
  （[Create and edit files with Claude](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)）
  → つまり **docx-js・openpyxl・pandas・markitdown・pandoc・LibreOffice がイメージに入っている**前提で書かれている。

### 1.1 docx（[SKILL.md](https://github.com/anthropics/skills/blob/HEAD/skills/docx/SKILL.md)）

- **作成**: `docx`（npm の docx-js）でスクリプトを書く。"preinstalled — do not run npm install first"。
- **編集**: ZIP を展開して `word/document.xml` を直し、zip で固め直す。
  「docx-js は既存ファイルを開けない」と明記されている。
- **読み**: `pandoc -t markdown file.docx`。
- **検証**: `python scripts/office/soffice.py --headless --convert-to pdf output.docx` → `pdftoppm` →
  生成した JPEG をモデルが読む（レンダリングして見る）。
- 補助スクリプト: `comment.py`（コメント）、`accept_changes.py`（変更履歴の受理）、`merge_runs.py`。
  XML のパースは `defusedxml` を使う（外部から来た docx を不信な入力として扱う）。

### 1.2 xlsx（[SKILL.md](https://github.com/anthropics/skills/blob/HEAD/skills/xlsx/SKILL.md)）

- **作成・編集**: `openpyxl`。大量データは `pandas`。ざっと見るのは `markitdown`（セル座標は出ないので編集の計画には使わない）。
- 式は文字列で書き、計算結果をハードコードしない。**出荷前に `recalc.py` で再計算することが必須**。
- **`recalc.py` の実装が要点**（[scripts/recalc.py](https://github.com/anthropics/skills/blob/HEAD/skills/xlsx/scripts/recalc.py)）:
  LibreOffice を一時プロファイルで起動し、**StarBasic のマクロ**（`ThisComponent.calculateAll()` + `store()`）を
  プロファイルに置いて再計算させ、**計算済みの値だけ**を元の xlsx に書き戻す。
  理由はコメントにある通り「`--convert-to` では再計算されない」から。
  （LibreOffice の `OOXMLRecalcMode` 既定が「再計算しない」であることと一致する。
   → [office-capability.md](office-capability.md) §2.1 と同じ穴を、Anthropic も同じ方法で塞いでいる）
- 検証: 式と値の 2 パス読み（`load_workbook` を 2 回）、エラーセル 0 が条件。

### 1.3 pptx（[SKILL.md](https://github.com/anthropics/skills/blob/HEAD/skills/pptx/SKILL.md)）

- **作成**: `pptxgenjs`。テンプレート流用・既存編集は ZIP 展開 + `ppt/slides/slideN.xml` の編集。
- 読み: `scripts/slide_text.py`（スライドごとの本文・表・グラフ・ノート）。
- 目視: `scripts/thumbnail.py` — **LibreOffice で PDF 化 → pdftoppm → PIL でラベル付きグリッド**。

### 1.4 サンドボックス用の soffice ラッパー（[scripts/office/soffice.py](https://github.com/anthropics/skills/blob/HEAD/skills/docx/scripts/office/soffice.py)）

hns の bwrap 対策としてそのまま参考になる 4 点。

1. `SAL_USE_VCLPLUGIN=svp`（画面の無いヘッドレス VCL プラグイン）
2. `-env:UserInstallation=<temp>` を毎回渡す。渡さないと
   「User installation could not be completed」で何も変換できない、とコメントに書いてある
3. **AF_UNIX ソケットが禁止された環境向けに `LD_PRELOAD` のシムを当てる**（実行時に検出して切り替え）
4. 描画前に**入力を一時コピーして外部リンクを落とす**（`_without_outside_links`）

## 2. Claude for M365 = Office.js アドイン

- Excel / PowerPoint / Word / Outlook の 4 つのアドインで、AppSource の 1 パッケージ（WA200010725）。
  管理者は Microsoft 365 管理センターの「統合アプリ」から配布する。
  （[Claude for M365 overview](https://claude.com/docs/office-agents/overview.md)）
- **Excel**: セル・数式・書式・ピボットテーブル・グラフを読み書き。セル単位の引用。Pro/Max/Team/Enterprise で GA。
  対応: Excel on the web、Windows は build 16.0.13127.20296 以降、Mac は 16.46 以降。
  （[Claude for Excel](https://claude.com/docs/office-agents/excel.md)）
- **Word**: 選択範囲の書式を保った編集、**Word 標準の変更履歴（トラック変更）モード**、コメントスレッドの処理、
  テンプレート流用。対応: Word on the web、Windows 2205 / build 15202.10000 以降、Mac 16.61 以降。
  （[Claude for Word](https://claude.com/docs/office-agents/word.md)）
- 実装上の意味: **ライブ文書をホストアプリのオブジェクトモデル（Office.js）で操作する**。
  ファイルのパースも変換もレンダリングも要らない。代わりに「Microsoft 365 が入っている環境」でしか動かない。

## 3. Google Workspace（Docs / Sheets / Slides）

- Google Workspace Marketplace から入れる拡張で、Docs / Sheets / Slides の **Extensions > Claude** から開く。
  1 回のインストールで 3 アプリに効く。管理者は組織単位で配布できる。
- **Google ネイティブ形式のみ**。Word / Excel / PowerPoint ファイルは Google 形式に変換しないと使えない。
  （[support article](https://support.claude.com/en/articles/16951679-use-claude-in-google-docs-sheets-and-slides)）

## 4. hns への含意

| 経路 | hns で使えるか | 理由 |
| --- | --- | --- |
| claude.ai 方式（skills + OOXML ライブラリ + LibreOffice） | **そのまま使える** | hns は machine で exec、sandbox あり。DSH の office-kit と同型で、スキル資産（Apache-2.0）も流用できる |
| M365 アドイン方式 | **不可** | hns の web に Excel / Word のホストが無い。ユーザーの M365 の中で動かす製品なら可能 |
| Google Workspace 方式 | **不可** | 同上 |

**盗むべき 3 点**

1. **再計算はマクロで `calculateAll()` させる**。設定（`OOXMLRecalcMode`）だけでは足りない、という実装知。
2. **sandbox 用の soffice ラッパー**（svp / 一時プロファイル / LD_PRELOAD / 外部リンク除去）。bwrap 内の実測（S1）の下準備になる。
3. **作成 → PDF → 画像 → 読む、をスキルに埋め込む**。レンダリングして見ないとレイアウトは直らない、という運用。

**hns が真似しない方がよい点**

- 生成言語が **docx-js（Node）と openpyxl（Python）に割れている**。スキルの都合で 2 ランタイムを同居させている。
  hns は TS なので、docx は docx-js、xlsx / pptx は Python か TS か、**1 つに寄せる**判断が先。

## 5. 未確認

- claude.ai のサンドボックスに入っている LibreOffice の版と日本語フォント（公開情報が無い）。
- Claude for Excel / Word が Office.js のどの API 集合を使っているか（内部実装は非公開。docs は機能面のみ）。
- `recalc.py` が LibreOffice の再計算と Excel の結果をどこまで一致させているか（テストは非公開）。
- Claude Code / Cowork が同じスキルをそのまま使うか（README は「Claude の文書機能」とのみ書く）。

## 6. 出典

- [anthropics/skills](https://github.com/anthropics/skills)（README、skills/docx・xlsx・pptx の SKILL.md と scripts）
- [Skills overview](https://claude.com/docs/skills/overview.md) / [Create and edit files with Claude](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)
- [Claude for M365 overview](https://claude.com/docs/office-agents/overview.md) / [Excel](https://claude.com/docs/office-agents/excel.md) / [Word](https://claude.com/docs/office-agents/word.md)
- [Use Claude in Google Docs, Sheets, and Slides](https://support.claude.com/en/articles/16951679-use-claude-in-google-docs-sheets-and-slides)
- [Claude can now create and edit files](https://www.anthropic.com/news/create-files)（README が指す発表）

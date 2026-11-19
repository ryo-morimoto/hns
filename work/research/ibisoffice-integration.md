# ibisOffice を採るための条件と統合設計

2026-11-17 / ユーザー判断「可能なら ibisOffice 系が良い。MS 互換がビジネス上強い」を受けた再検討。
前提の調査は [office-capability.md](office-capability.md)、Claude の実装は [claude-office.md](claude-office.md)、
競合は [office-ecosystem.md](office-ecosystem.md)。

## 0. 判断

**採れる。ただし「今の ibisOffice をそのまま中核に据える」のではなく、3 つの条件を設計で満たす。**

1. **エンジン境界を hns 側で持つ**（アダプタ越しに呼ぶ）。ibisOffice は「交換可能なエンジン実装」の 1 つにする。
2. **AGPL を配布形態で解く** → **B に決定**（同梱して、LICENSE・NOTICE・対応ソース・About の帰属表示を守る）。
3. **忠実度の計測はしない** → 決定済み。検証は「動く・壊れない」の最小限だけにする。

理由は前回調査の「操作 API が無い」を、**クレート層まで降りると覆せる**から。`ibis-pptx`（名前は pptx だが
docx/xlsx/pptx の read/save を持つ）は GPUI に依存せず、**ヘッドレスの read/save と数式計算だけのバイナリを既に同梱**している。

## 1. MS 互換を「武器」にできる根拠（事実）

- ibisOffice は「Office で作った文書を開いても見た目が崩れない」を製品目標に置き、**Office が出力した PDF と
  画素比較する 7 万超のテスト**を主張している（README）。実装一覧は 1,832 項目すべて完了。
- **保存が差分方式**。`ibis-office-roundtrip keep` は「変更のないパーツをそのまま書き戻す」モードで、
  `rewrite` は全 XML を書き直す検証モード。つまり「往復で壊れないこと」を自分で検査できる形になっている
  （`crates/ibis-pptx/src/bin/roundtrip.rs`）。
- **数式エンジンに Excel との一致検査がある**。`ibis-calc-check` は Excel が保存した値を正解として、
  すべての数式を評価して突き合わせる（15 桁一致、乱数・時刻関数は除外）。`calc` は 500 超の関数、
  `LET`/`LAMBDA`、動的配列、3D 参照まで対応と主張（`crates/ibis-pptx/src/bin/calc_check.rs`）。
- これは LibreOffice に対する**構造的な差**。LibreOffice は OOXML の再計算を既定で行わず（`OOXMLRecalcMode=1`）、
  レイアウトもフォント差で崩れる。Anthropic でさえ再計算は「StarBasic マクロで `calculateAll()`」という力技で埋めている。

## 2. 技術事実（統合の土台）

| 事実 | 根拠 |
| --- | --- |
| `ibis-pptx` は docx/xlsx/pptx の read/save。依存は `ibis-calc` / `ibis-doc-model` / `ibis-ooxml` / miniz_oxide / roxmltree / encoding_rs **のみ（GPUI 無し）** | `crates/ibis-pptx/Cargo.toml`, `src/lib.rs` |
| ヘッドレスで「開いて保存」だけのバイナリが既にある（`keep` / `rewrite`、終了コード 2 = エラー） | `src/bin/roundtrip.rs` |
| 数式の Excel 一致検査バイナリがある（`--tsv` / `--function` で関数別集計） | `src/bin/calc_check.rs` |
| GUI 側（`ibis-office-app` / `-shell` / `-render`）は GPUI 依存。ただし shell に **headless レンダラ（`headless.rs`）** があり、`export` 機能で有効化される | 各 Cargo.toml の説明 |
| CLI のヘッドレス書き出しは `--export pdf\|png\|pdf-image\|ui`、`--slides` / `--width` / `--out-dir` | `docs/cli-options-ja.md` |
| 形式変換（docx→odt/csv 等）と `xlsx→csv` の CLI は無い（GUI 機能） | 同上・実装一覧 |
| WASM は `run` / `set_embed_options` の 2 関数、保存は `ibisoffice:download` イベント | `docs/web-embedding-ja.md` |
| すべてのソースに AGPL-3.0-only + §7(b) のヘッダ。`publish = false`（crates.io 未公開） | 各ソースの SPDX 行、`Cargo.toml` |

**含意**: 「読む・保存する・計算する」は**今日のクレートでヘッドレスに組める**。足りないのは「編集コマンドを受けて
保存する JSON 面」だけで、これは #159（MCP サーバー提案）と同じ設計になる。GUI の PDF/PNG 書き出しも
headless レンダラ経由なので、DISPLAY 無しで動く見込み（GPU バックエンドの実測は必要）。

## 3. 統合アーキテクチャ

**エンジン境界を hns 側で持つ。** ibisOffice を「唯一の実装」にしない。

```
@hns/agent / machine
  └─ OfficeEngine（TS の interface）
       ├─ ibisoffice   : engine pack（CLI + JSON sidecar）  ← 第一候補（忠実度）
       ├─ libreoffice  : soffice（形式の広さ・フォールバック）
       ├─ officecli    : 単一バイナリ（編集の代替）
       └─ native-js    : docx-js 等（軽い生成だけ）
```

```ts
interface OfficeEngine {
  readonly id: "ibisoffice" | "libreoffice" | "officecli" | "native-js";
  readonly version: string;
  capabilities(): Readonly<{
    read: readonly Format[];          // docx / xlsx / pptx / pdf
    write: readonly Format[];
    convert: readonly [Format, Format][];  // ibisOffice: 同形式と pdf/png のみ
    render: "pdf" | "png" | "none";
    recalculate: boolean;
    edit: boolean;
    roundtripCheck: boolean;
  }>;
  inspect(input: Path): Promise<DocumentSummary>;      // 構造・ページ数・数式数・未対応要素
  render(input: Path, page: PageSelection): Promise<ImageFiles>;
  convert(input: Path, to: Format): Promise<OutputFile>;
  recalculate(input: Path): Promise<RecalcReport>;      // 値と差分
  apply(input: Path, ops: readonly EditOp[]): Promise<SaveReport>;  // 原子的・別名保存
  verify(input: Path): Promise<VerifyReport>;           // 往復 + XSD + 未対応要素
}
```

**ルーティング規則**（hns が決める。エンジンには決めさせない）

| 操作 | 第一 | 条件付きフォールバック |
| --- | --- | --- |
| 表示忠実度が問われる PDF/PNG 化 | **ibisoffice** | libreoffice（形式が非対応のとき） |
| docx/xlsx/pptx の編集・保存 | **ibisoffice** | officecli、native-js（軽い生成） |
| 形式変換（odt/csv/txt/html/doc/xls） | libreoffice | — |
| 再計算 | **ibisoffice**（calc） | libreoffice（マクロ recalc） |
| 破損検出・往復検証 | **ibisoffice**（roundtrip） | libreoffice（再オープン + XSD） |

**重要な線引き**: エンジンは「ファイルを受け取り、ファイルを返す」だけにする。権限・監査・上限・パス封じ込めは
hns 側（capability 契約 / machine の bwrap）に残す。エンジンにワークスペースを渡さない。

## 4. 3 つの統合パス

| パス | 内容 | 工数（推測） | リスク |
| --- | --- | --- | --- |
| **P0: CLI 書き出し** | 既存の `ibisOffice --export pdf/png` を exec。描画・PDF 化だけを ibisOffice に任せ、変換と編集は他へ | 1〜2 週 | ヘッドレス GPU の実測、日本語フォントの同梱、AGPL の同梱回避 |
| **P1: JSON sidecar** | `ibis-pptx` + `ibis-calc` をリンクした小さな Rust バイナリを作り、stdin/stdout の JSON で read/edit/save/recalc/roundtrip を提供（#159 の設計のサブセット）。S23 で docx/xlsx の最小編集は実証済み | 3〜6 週 | 内部 API の互換（v0.8・semver 無し）、モデルの Command をどこまで公開するか |
| **P2: WASM プレビュー** | 65 MB の wasm + WebGPU を web に置き、iframe + `ibisoffice:download` で閲覧・編集 | 2〜4 週 | WebGPU 非対応環境、初回ロード、65 MB の配布 |

**推奨は P0 → P1 の順**。P0 はスパイク済み（[スパイク結果](ibisoffice-spike/README.md)）。
P1 は編集 API が公開されていることを確認済み（`Command` / `SheetCommand` / `FlowCommand` + `save`）。
P1 を upstream の #159 に合流できれば fork を減らせる（その場合は upstream 側が AGPL の面倒も見る）。

## 5. ライセンス（AGPL をどう解くか）

ibisOffice は **AGPL-3.0-only + 商用**。NOTICE に §7(b) の追加条件（派生物の UI に「Powered by ibisOffice」+
リンク）があり、§13 はネットワーク提供時のソース開示を要求する。hns の配布形態ごとに:

| 形態 | AGPL の扱い | 実装 |
| --- | --- | --- |
| **A. エンジンを同梱しない**（推奨） | hns は TypeScript のアダプタだけを配り、engine pack は利用者が導入。プロセス境界で arm's-length。§7(b) は hns の About 画面に 1 行足す | npm の optional 依存 / セットアップ手順。DSH が LibreOffice を optional 依存にしたのと同じ形 |
| **B. 同梱して AGPL を守る** | hns の配布物に ibisOffice のソース（または取得手段）を添付し、UI に帰属表示 | 配布パイプラインにソース同梱。§13 の「対応するソース」の範囲を法務確認 |
| **C. 商用ライセンス** | 条件・価格は非公開（問い合わせのみ）。買えば AGPL の義務は消える | 商談。ビジネス上「MS 互換」を売りにするなら B か C の判断が要る |

**決定（ユーザー）: B — 同梱して AGPL を守る。** 実装すること:

- 配布物に `LICENSE`（AGPL-3.0）と `NOTICE` を同梱し、ibisOffice の完全な対応ソース（版を固定した tarball か
  SHA 付きの取得手順）を一緒に配る。hns 側の改変（あれば）も同じ場所に置く。
- About 画面に「Powered by ibisOffice」と https://github.com/ibisjp/ibis-office へのリンクを出す（§7(b)）。
- サーバーとして第三者に提供する形態（SaaS）では §13 の「対応するソースの提供」が利用者に及ぶ。
  セルフホスト（利用者 = 運用者）なら配布物に含めることで足りる。
- 商用ライセンスの検討は保留（B で運用できなくなったときの選択肢として残す）。

## 6. 検証は最小限にする（忠実度の計測はしない）

**決定（ユーザー）: 忠実度の計測はやらない。** それは hns の強みではなく、計測基盤の維持コストだけが残る。
代わりに、**「動く・壊れない」だけを最小限で機械的に見る**。

- **往復**: `roundtrip keep` がバイト同一を返すこと（ibisOffice 自身の性質なので、hns 側は結果を記録するだけ）。
- **出力の妥当性**: PDF の先頭が `%PDF-`、ページ数が 0 でない、サイズが上限内。
- **失敗の分類**: タイムアウト・メモリ超過・未対応形式を、エンジンごとの閉じたコードに落とす。
- 画素比較・関数別一致率・顧客文書のベンチマークは**作らない**。必要になったら、そのとき顧客ごとに 1 回だけ測る。

## 7. スパイクの結果（2026-11-17 実行）

詳細は [ibisoffice-spike/README.md](ibisoffice-spike/README.md)。

| # | 問い | 結果 |
| --- | --- | --- |
| S12 | `--export pdf` は GPU・DISPLAY 無しで動くか | **合格**。docx 1.86 s / pptx 2.51 s / xlsx 17.1 s、bwrap 内でも 1.89 s |
| S12b | 画像化はできるか | **不合格**。`render_to_image not available: no HeadlessRenderer configured` → PDF → pdftoppm で代替 |
| S13 | 往復で壊れないか | **合格**。docx/xlsx/pptx の 3 本すべて `keep` が**バイト同一**（107 / 612 / 206 ms） |
| S14 | 数式の一致 | **やらない**（忠実度計測を採らない決定） |
| S15 | 最小バイナリが組めるか | **合格**。`cargo build -p ibis-pptx --bin ibis-office-roundtrip` が 1 分 20 秒。編集 API（Command / SheetCommand / FlowCommand）は公開 |
| S16 | 商用ライセンス | **不要**（B 案で運用。商用は保留） |
| S17 | 日本語フォント | **合格**。fontconfig を使う。`FONTCONFIG_FILE` で system 設定を include し、IPAex/Noto のディレクトリを足せば PDF に埋め込まれる |
| S18 | メモリのモデル | **要注意（誤計測ではない）**。RSS ≈ 60 MB + **4〜5 KB × セル数**。59 万セルの実測で 2.55 GB、100 万セルで 4.4〜5.8 GB |
| S20 | 安定性 | 決定的（同じ入力 5 回で PDF がバイト同一）、壊れたファイルは 0.01 s で失敗、並列 2 も成功。**ただし内部 timeout 無し**（441 s 走って OOM abort） |
| S21 | 事前スキャン | **合格**。セル数を 3〜149 ms で数えられる。RSS ≈ 60 MB + 5 KB × セル数で予測（安全側 2 倍） |
| S22 | 巨大画像 | **合格**。RSS ≈ 4 × 生ピクセル。6000×6000 で 450 MB / 0.45 s |
| S23 | P1 の編集 | **成立**。docx は document.xml の 1 パーツだけ変更、xlsx は式と計算値まで保存し自己往復でバイト同一 |
| S24 | 日本語の実務文書 | **合格**。ヘッダ・フッタ・ページ番号・表・画像が正しく描画（2 ページを目視） |

## 8. リスクと撤退条件

- **メモリ**: セル数に比例（約 5 KB/セル）。普通の文書は 100〜500 MB だが、100 万セルで 4〜6 GB。→ 事前スキャン（S21: 3〜149 ms）でセル数を数え、
  上限（例: 30 万セル）を超える文書は別経路（LibreOffice）に逃がすか拒否する。画像は 4 × 生ピクセルで見積もる。
- **timeout が無い**: 病的な入力で 441 秒走った。→ hns の外側で必ず打ち切る。OOM は abort（SIGABRT）で返るので、
  「落ちた＝失敗」として扱い、リトライしない。
- **API の不安定さ**: v0.8・`publish = false`・semver 無し。→ P1 は「モデルの Command のうち、テキスト・セル・数式だけ」に絞る。
  それ以上は P0（PDF 化）と LibreOffice に逃がす。
- **単一ベンダー**: 1 社・1 リポジトリ・1 人（主要コントリビュータ）。→ 撤退条件を先に決める:
  「S12〜S14 のいずれかが 2 四半期改善しない」「更新が 3 か月止まる」「商用条件が合わない」。
- **AGPL**: 配布形態 A で回避できるが、SaaS 提供時に詰まる。→ 法務確認を先に。
- **GPU**: headless レンダラは GPU バックエンド（wgpu / Vulkan）に依存する可能性。software（lavapipe）で速度が出なければ P0 が崩れる。
- **フォント**: 同梱フォントが無い（Help > Setup でダウンロードする設計）。hns はイメージに固定で入れる。

## 9. 出典

- ibisOffice: `Cargo.toml`、`crates/ibis-pptx/{Cargo.toml,src/lib.rs,src/bin/roundtrip.rs,src/bin/calc_check.rs}`、
  `crates/ibis-office-{shell,render,app}/Cargo.toml`、`docs/cli-options-ja.md`、`docs/web-embedding-ja.md`、
  `NOTICE`、`README.md`（70,000 テスト・ベンチマーク）、issue #159
- 比較: LibreOffice の `OOXMLRecalcMode`（`officecfg/.../Calc.xcs`）、Anthropic skills の `recalc.py`
- 前提: [office-capability.md](office-capability.md) §2.2、[office-ecosystem.md](office-ecosystem.md) §2

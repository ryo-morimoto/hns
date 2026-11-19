# Office の構造設計（最終系のイメージ）

2026-11-17 / レビュー用。前提は [ibisoffice-integration.md](ibisoffice-integration.md) と [ibisoffice-spike/README.md](ibisoffice-spike/README.md)。
**エンジンを載せることが目的ではない。** 利用者が文書を「見る・直す・渡す」が、hns の画面と会話の中で自然に回ることが目的。
LibreOffice のフォールバックは**持たない**（1 エンジン = ibisOffice のみ）。

---

## 1. 体験の最終系

### 1.1 見る（Phase 0 の中心）

```
workspace: 提案書.docx
   │  利用者がファイルツリーで開く（または会話で「見せて」）
   ▼
Session DO ── GraphQL: documentPreview(path) ──▶ { status: "ready", url, pages, engine, generatedAt }
   │                                            （未生成なら queued → 数十秒で ready）
   ▼
Web: 右パネルに PDF プレビュー（ページ送り・拡大・テキスト選択）
     バッジ: 「2 ページ / ibisOffice 0.8.7 / 30 秒前に生成」＋「原本をダウンロード」
```

- 初回は machine が 2 秒で PDF を作る。2 回目以降は**内容の版**が同じなら作り直さない。
- プレビューは **PDF をそのまま web に返す**（PDF.js）。PNG 化しない。
- 生成に失敗しても原本は無傷（派生ファイルだけが失敗する）。

### 1.2 直す（Phase 1）

```
利用者「2 ページ目の表の金額を 10% 上げて」
   ▼
Agent: office_inspect → 表のセルを特定
       office_edit   → 変更案（コマンド列）を適用し、新しい版として保存
   ▼
Web: 変更カード「3 セルを更新」＋「プレビュー」「元に戻す」
     （版と差分は既存の workspace の仕組みに乗る。新しい履歴は作らない）
```

- 編集は**必ず新しい版**として書く（既存の `expectedVersion` と同じ規則）。
- 変更が適用できないときは**何も書かない**（原子的）。未対応の変更は型付きエラーで返す。
- プレビューは版が変わったときだけ再生成。

### 1.3 渡す（Phase 2）

- 「PDF で出して」→ `office_convert(pdf)` → workspace に `提案書.pdf`（派生ではなく成果物）→ ダウンロード。
- 変換できるのは **PDF のみ**（LibreOffice を外したため odt/csv/html は対象外）。この制約は UI にも出す。

### 1.4 エージェントが見る（目視 QA）

```
Agent: office_render(path, { pages: [2], width: 1280 })
   ▼
machine: ibisOffice --export png（ソフトウェア Vulkan で 0.2 秒/ページ）
   ▼
workspace/.hns/artifacts/<hash>/p2.png → Agent に画像として渡す（既存の attachment 経路）
   ▼
Agent: 「表の罫線が欠けている」→ office_edit で直す
```

- **同じエンジンで描く**（PDF と同じ描画系）。pdfium 等の追加ラスタライザを持たない。
- 制限: 1 回 10 ページまで、幅 1600 px まで、画像は派生ファイル扱い（GC 対象）。
- 前提: pack に **mesa(lavapipe) + vulkan-loader** を含め、`VK_ICD_FILENAMES` を exec 環境に渡す。

### 1.5 制限・失敗の見せ方

| 状況 | 見せ方 |
| --- | --- |
| エンジン未導入 | 「Office プレビューは未設定です」＋ セットアップ手順（1 行） |
| 大きすぎる（セル 30 万超など） | 実行前に「このブックは大きすぎます（推定 6 GB / 上限 2 GB）」＋ 対処案 |
| タイムアウト（60 秒） | 「時間内に変換できませんでした」＋ 再試行（原本は無傷） |
| フォント欠け | プレビューに「一部のフォントが代替されました: MS Gothic」の注記 |
| 破損ファイル | 「ファイルが壊れています」（エンジンが即座に返す） |

---

## 2. モジュールと責務

**新しいパッケージは作らない。** 既存 8 パッケージの責務の内側に置く（D029 / D047 の「育ったら切る」）。

| 場所 | 責務 | 持たないもの |
| --- | --- | --- |
| `@hns/core` の `src/office.ts` | **語彙と契約**: 形式・ジョブ・結果・エラーコード・上限・エンジン能力・監査イベントの型と valibot schema | 実行、保存、HTTP、パスの解釈 |
| `@hns/workspace` の `src/artifacts.ts` | **派生ファイル**（プレビュー PDF など）の保存・版との紐付け・GC。成果物（ユーザーの PDF）は通常のファイルとして書く | 変換の実行、表示 |
| `@hns/machine` の `src/office/` | **実行**: 事前スキャン、キュー、bwrap 内のプロセス起動、timeout・メモリ上限、成果物の書き出し、エンジン manifest の読み込み | 権限判定、UI、会話 |
| `@hns/agent` の `src/office-tools.ts` | **モデル向けの面**: ツール定義（strict schema）、risk、ジョブへの変換、結果の要約 | 実行、保存 |
| `@hns/server` の `src/graphql/office.ts` | **アプリ契約**: `documentPreview` / `officeJob` / `officeEngine` のクエリと購読、ジョブレコード、監査イベント | 実行、ファイル内容 |
| `@hns/web` の `src/office/` | **見せ方**: PDF ビューア、変更カード、エンジン状態、失敗の案内 | 変換、認可 |
| `office-pack/`（リポジトリ外の配布物） | エンジン本体・フォント・fonts.conf・X11 ライブラリ・LICENSE/NOTICE・対応ソース・install | 製品コード |

### 依存の追加（許可する線だけ）

```
web ──▶ core
server ──▶ core / agent / store
agent ──▶ core / workspace
machine ──▶ core / workspace
workspace ──▶ core
（office-pack はプロセス境界の外。コード依存なし）
```

**新しい線は 1 本も引かない。** 既存の依存方向（server → agent/store/workspace → core、machine → workspace → core）で足りる。
machine の wire 型が server から見えない問題は、**Office のジョブ型を core に置く**ことで解く（machine はそれを実装する）。

---

### 2.1 リポジトリ上の姿

```
packages/
  core/src/office.ts              ← 契約（型 + valibot schema + エラーコード）
  core/src/office.test.ts
  workspace/src/artifacts.ts      ← 派生ファイル（版に紐づく・GC 対象）
  machine/src/office/
    executor.ts                   ← ジョブ実行（bwrap 内プロセス）
    prescan.ts                    ← セル数・画素数・展開サイズの見積もり
    pack.ts                       ← engine manifest の読み込みと検証
    queue.ts                      ← 同時 1・timeout・再起動
  agent/src/office-tools.ts       ← モデル向けツール（strict schema）
  server/src/graphql/office.ts    ← アプリ契約（preview / engine / 失敗）
  web/src/office/
    PreviewPanel.tsx              ← 右パネルの文書
    PdfViewer.tsx                 ← PDF.js
    OfficeJobCard.tsx             ← queued / ready / failed
    EngineNotice.tsx              ← 未設定・フォント代替の案内

office-pack/                      ← 配布物。コード依存はない（プロセス境界）
  manifest.json                   ← id / version / capabilities（pdf・png）/ license
  bin/ibisOffice
  fonts/  fonts.conf              ← IPAex / Noto CJK + fontconfig
  lib/                            ← X11（libxcb / libxkbcommon / libxkbcommon-x11）
  vulkan/                         ← mesa lavapipe + vulkan-loader + lvp_icd.json
  LICENSE  NOTICE  SOURCE.md      ← AGPL の同梱物（B 案）
```

## 3. 契約（先に凍結する）

### 3.1 語彙（`@hns/core/src/office.ts`）

```ts
export const OFFICE_FORMATS = ["docx", "xlsx", "pptx", "pdf"] as const;
export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

export const OFFICE_OPERATIONS = ["preview", "inspect", "edit", "convert", "recalc"] as const;
export type OfficeOperation = (typeof OFFICE_OPERATIONS)[number];

export interface OfficeInput {
  readonly path: string;                     // workspace 相対
  readonly version: string;                  // 読んだ版（これが変われば拒否）
  readonly format: OfficeFormat;
}

/** 1 回の依頼。operation が判別子（options を別 union にしない＝二重管理しない）。 */
export type OfficeJob = { readonly v: 1; readonly id: string; readonly input: OfficeInput; readonly limits: OfficeLimits } & (
  | { readonly operation: "preview"; readonly pages?: readonly number[]; readonly dpi?: number }
  | { readonly operation: "inspect" }
  | { readonly operation: "edit"; readonly commands: readonly OfficeCommand[] }
  | { readonly operation: "convert"; readonly to: "pdf" }
  | { readonly operation: "render"; readonly pages?: readonly number[]; readonly width?: number }
  | { readonly operation: "recalc" }
);

export interface OfficeLimits {
  readonly maxInputBytes: number;            // 50 MiB
  readonly maxCells: number;                 // 300_000
  readonly maxPixels: number;                // 24_000_000（4 × 生 96 MB）
  readonly timeoutMs: number;                // 60_000
  readonly maxOutputBytes: number;           // 100 MiB
}

export const OFFICE_ERROR_CODES = [
  "unsupported_format", "input_too_large", "too_many_cells", "too_many_pixels",
  "engine_unavailable", "engine_timeout", "engine_failed", "output_too_large",
  "source_changed", "not_authorized", "cancelled",
] as const;
export type OfficeErrorCode = (typeof OFFICE_ERROR_CODES)[number];

export type OfficeResult =
  | { readonly ok: true; readonly artifact: OfficeArtifact; readonly stats: OfficeStats }
  | { readonly ok: false; readonly error: OfficeErrorCode; readonly message: string };

export interface OfficeArtifact {
  readonly path: string;                     // 派生（プレビュー PDF）か成果物（変換 PDF）
  readonly bytes: number;
  readonly pages?: number;
  readonly missingFonts: readonly string[];
  readonly engine: { readonly id: "ibisoffice"; readonly version: string };
}
```

**編集コマンド**は「エージェントが壊しにくい語彙」に絞る（P1 の範囲）:

```ts
export type OfficeCommand =
  | { readonly op: "setText"; readonly target: ParagraphTarget; readonly text: string }
  | { readonly op: "setCells"; readonly sheet: string; readonly cells: readonly CellEdit[] }
  | { readonly op: "appendParagraph"; readonly after?: ParagraphTarget; readonly text: string };

/** 段落は inspect が返す id で指す（本文一致は曖昧なので使わない）。 */
export interface ParagraphTarget {
  readonly paragraphId: number;
}

export interface CellEdit {
  readonly ref: string;                      // "B12"
  readonly value: { readonly kind: "text"; readonly text: string }
               | { readonly kind: "number"; readonly value: number }
               | { readonly kind: "formula"; readonly formula: string };  // "=SUM(B2:B9)"
}
```

### 3.2 機械の面（machine の wire）

既存の閉じた op 集合に 1 つ足す。

```ts
// packages/machine/src/wire.ts（既存の union に追加）
| { readonly op: "office"; readonly job: OfficeJob }
```

応答は `OfficeResult`。**ファイルの中身は応答に載せない**（パスと件数だけ）。256 KiB の応答上限に収まる。

### 3.3 アプリ契約（GraphQL）

```graphql
type OfficeError { code: String!  message: String! }

type DocumentPreview {
  path: String!
  version: String!
  status: PreviewStatus!        # queued | ready | failed | unsupported | disabled
  url: String                   # 署名付き・短命。ready のときだけ
  pages: Int
  missingFonts: [String!]!
  engine: String                # "ibisOffice 0.8.7"
  generatedAt: DateTime
  error: OfficeError             # code + message
}
```

- クエリ `preview(path)` は**状態を返すだけ**。生成は mutation `requestPreview(path)` が enqueue する（冪等: 同じ版なら 1 回）。
- 進捗は既存の Session イベント（購読）に乗せる。新しい購読経路は作らない。
- 成果物（PDF 変換）は既存のファイル操作と同じ扱い（`write_file` 相当の mutation で作られる）。

### 3.4 監査

`office.job` イベント 1 本。内容は `{ jobId, operation, path, version, inputHash, engineVersion, ms, outcome }`。
**文書の中身・セル値・テキストは入れない**（既存の「ログに本文を入れない」規則）。

---

## 4. 並列実装の分割（壊れにくさの作り方）

### 4.1 凍結点（ここが決まれば 4 本を同時に流せる）

1. `@hns/core/src/office.ts`（型 + schema + エラーコード）
2. 上記の GraphQL SDL（`core/graphql` から生成）
3. machine の wire（`op: "office"`）

これらは**1 つの小さな issue**で先に着地させる。以降、型を変える変更は「契約変更」として別扱い。

### 4.2 レーンと担当ファイル（重ならない）

| レーン | 触るファイル | 依存 | 完了条件 |
| --- | --- | --- | --- |
| L0 契約 | `packages/core/src/office.ts`（+ test）, `packages/core/src/types.ts` の追記 | なし | 型・schema・エラーコードがテストで固定される |
| L1 実行 | `packages/machine/src/office/*`, `wire.ts` | L0 | 実ファイルで preview/convert が通り、上限・timeout が効く |
| L2 成果物 | `packages/workspace/src/artifacts.ts` | L0 | 版に紐づく派生ファイルの保存・取得・GC |
| L3 面 | `packages/agent/src/office-tools.ts`, `packages/server/src/graphql/office.ts` | L0（L1/L2 は fake で可） | ツール定義とクエリが契約どおり。fake executor で通る |
| L4 画面 | `packages/web/src/office/*` | L0 + SDL | queued/ready/failed の 3 状態が出る |
| L5 統合 | 全部 | L1〜L4 | 実エンジンで「開く→見る→直す→PDF」が通る |

**衝突しやすい共有ファイル**（触るのは 1 レーンだけにする）:
`packages/agent/src/tools.ts`（0221/0226 と共有）、`packages/machine/src/wire.ts`（L1 のみ）、
`packages/server/src/graphql/schema.ts`（生成物。L0 の後に再生成）、`packages/web/src/app/routes`（L4 のみ）。

### 4.3 壊れないための規則

- **契約は core、実装は下流。** 下流が独自の型を定義したらレビューで落とす。
- **ジョブは冪等**。同じ `(path, version, operation, options)` は同じ結果（キャッシュキー）。
- **版の一致を入口で見る**。`input.version` が現在と違えば `source_changed`（TOCTOU を閉じる）。
- **失敗はファイルを残さない**。派生は temp → rename。成果物は既存の `write()` の版規則に乗せる。
- **エンジンの版を結果に含める**。互換性の切り分けができる。
- **契約のゴールデン**: `OfficeJob` / `OfficeResult` の JSON fixture を core のテストに置き、全レーンが
  自分の schema をそれで検証する。レーン間の解釈違いはここで落ちる。

---

## 5. 段階と issue の形（まだ作らない）

```
L0 契約 ──┬─ L1 実行 ──┐
          ├─ L2 成果物 ─┼─ L5 統合（Phase 0: 見る）
          ├─ L3 面 ─────┤
          └─ L4 画面 ───┘
                         └─ Phase 1: 直す（edit コマンド）
                              └─ Phase 2: 渡す（PDF 変換・再計算）
```

- Phase 0 の完了条件は「**workspace の docx/xlsx/pptx を web で開いて読める**」。エンジンの話ではなく体験の話。
- Phase 1 で「直す」、Phase 2 で「渡す」。**Phase 0 が出るまで edit を作らない**（見えないものは直せない）。

---

## 6. レビューしてほしい点

1. ~~プレビューの経路~~ → **決定: PDF を web に返して PDF.js**（追加依存なし。将来はサーバ側キャッシュ等で最適化）。
2. ~~エージェントに画像を渡すか~~ → **決定: 目視 QA をする**。PNG は同じエンジンで出す（スパイクで実証済み）。
3. **成果物の置き場**: 下の 3 案から選ぶ。**推奨は B（派生は machine のキャッシュ、成果物は通常ファイル）**。

### 6.1 置き場の選択肢

| | A. ワークスペース内 `.hns/artifacts/` | B. machine のキャッシュ（推奨） | C. クラウド（R2 等） |
| --- | --- | --- | --- |
| 場所 | `<workspace>/.hns/artifacts/<contentHash>.pdf` | `~/.cache/hns/office/<workspaceId>/<contentHash>.pdf` | オブジェクトストレージ + 署名 URL |
| 長所 | 実装最小・rename で原子的・バックアップに乗る・マシン移行でも残る | ワークスペースが汚れない・キャッシュとして自然・GC が単純・権限が独立 | 複数端末で共有・web から直接配信 |
| 短所 | ワークスペースが太る・一覧/エディタ/journal から除外する規則が要る・ユーザーが触れる | マシンを移すと消える（再生成でよい）・workspaceId の安定キーが要る | インフラ追加・コスト・ローカル性の喪失・D1/DO にバイナリを置かない方針 |
| GC | 版・サイズ上限で削除 | mtime/LRU で削除（既定 7 日） | ライフサイクル規則 |
| 向くもの | 成果物を残したい場合の代替 | **派生**（プレビュー PDF・QA の PNG） | 共有・配信が必要になったら |

**推奨の組み合わせ**: 派生（プレビュー・画像）は **B**、ユーザーが求めた PDF は**通常のワークスペースファイル**として書く。
A は「派生もマシン移行で残したい」となったときの代替。C は共有要件が出るまで採らない。

既製品（WOPI / Collabora / ONLYOFFICE / Box / Dropbox / Graph / Nextcloud / Seafile / Gotenberg / CloudConvert /
DSH office-kit）の設計は [office-preview-design.md](office-preview-design.md) に整理した。収束点は「派生は文書ストアの外・
版キー・サーバ側の GC・URL を capability にしない・ページ単位か上限で拒否」。B はこの収束点に一致する。
4. **編集の範囲**: P1 は「テキスト・セル・数式」の 3 種類で足りるか（書式・画像・表の追加は後）。
5. **エンジンの配布**: リポジトリ同梱（B 案）でも、pack を別リポジトリ/別ダウンロードにするか。
6. **上限値**: 30 万セル / 24 M ピクセル / 60 秒 / 入力 50 MiB でよいか。
7. **大きなファイルの体験**: 拒否だけか、先頭 N ページだけの簡易プレビューを許すか。

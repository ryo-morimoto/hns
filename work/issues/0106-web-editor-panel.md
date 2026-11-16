# 0106: Editor 右パネル（CodeMirror / 保存 / 競合 / diff）

status: open
priority: next
design: agreed
design-ref: D092
depends-on: 0102, 0125, 0157
touches: packages/web/src/components/Editor, packages/web/src/screens/editor, packages/web/src/styles/editor.css, packages/web/test/editor, packages/web/package.json, package-lock.json

## Goal

会話の文脈を壊さず、右パネルでファイルを見て直す。
ファイル一覧、CodeMirror 6、保存、競合の再読込/上書き、diff、dirty の確認を提供する。

## Acceptance criteria

- [ ] ファイル一覧（ルート配下、0125 の除外規則、検索は `fileSearch`）
- [ ] 選定したエディタ（CM6）で編集。行番号、Tab、⌘S、読み取り専用エラーの表示
- [ ] 保存は expectedVersion + operationId。applied / conflict / unknown を区別
- [ ] 競合は「外部で変更されました」+ 再読込 / 上書き。diff で確認できる
- [ ] パネルを閉じる・会話を移る・ホームへ戻るとき、dirty なら確認。確認後は buffer を捨てる
- [ ] 右パネルの開閉は URL に入り、戻る/進むで戻る。モバイルは全画面
- [ ] 読み込み中 / 空 / 読めない / 長いファイル / バイナリ の状態
- [ ] テスト: buffer 状態機械、保存、競合、dirty guard、diff

## Notes

- CodeMirror 6 の exact pin と理由を D043 に追記する（既に engineering で選定済み）
- EditorBuffer 相当の状態機械を React の外に置き、テスト可能にする
- 行番号・diff の gutter は自前。Monaco は使わない
- 0105 の会話画面に右パネルとして載せる。独立 route にはしない

## Design（D092 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D092）。CM6 は暫定で、NFR を満たさない場合は再判断する。

### 前提

- 0105 の会話画面の右パネルに載せる。シェルは `panel?: ReactNode` のスロットを持つ。
- tree / search は 0125 の GraphQL（`files` / `fileSearch`）。content の読み書きは 0157 の REST（D077 の分割）。
- 保存は `expectedVersion` + `operationId`。outcome は applied / conflict / unknown を区別する（docs/durability.md §3.1）。
- エディタの選定は要件と比較で決める（U-06）。docs/engineering の CM6 は1行の仮置きで、根拠は `work/research/editor-selection.md`。pin は実装時に package.json へ（lock owner）。

### 決定 1: EditorBuffer は React の外の状態機械

- `web/src/screens/editor/buffer.ts` に置く。React は表示だけ。
- 状態: `closed` / `loading` / `clean` / `dirty` / `saving` / `conflict` / `unknown` / `readonly` / `error`。
- 入力: `open(path)` / `loaded(content, version)` / `edit(content)` / `saveStart` / `applied(version)` / `conflict(server)` / `unknown` / `reload` / `discard` / `close`。
- 不変条件: `dirty` は loaded の内容との比較で決める（保存後に edit されたら再び dirty）。`saving` 中の edit は受け付けるが、保存結果は編集後の内容を上書きしない（version で照合）。`unknown` は再読込するまで保存しない。

### 決定 2: 一覧と検索は 0125 の GraphQL

- 右パネルの一覧は `Query.files` をディレクトリ展開ごとに呼ぶ（lazy）。検索は `Query.fileSearch`（クライアント filter はしない）。
- hidden / excluded / symlink は 0125 の規則。プロジェクト切替で一覧と buffer をリセットする。

### 決定 3: エディタの薄いラッパー（U-06 の結果に従う）

- `components/Editor/CodeMirror.tsx`: `value` / `onChange` / `readOnly` / `onSave`。行番号、Tab、⌘S / Ctrl+S。選定が変わってもこの境界は保つ。
- 言語のシンタックスハイライトは v1 では付けない（拡張を増やさない）。テーマは CSS 変数。
- 読み取り専用（権限・読めない・binary）では編集を無効にし、理由を出す。

### エディタ選定（D092 で決定）

要件: R1 会話の右パネル / React 19 / jsdom、R2 モバイル、R3 任意のテキスト・IDE 機能なし、R4 行番号・Tab・⌘S・長いファイル、R5 行 diff、R6 lazy chunk 350KB gzip 以下、R7 CSP・言語サービス Worker なし、R8 保守・TS 型・拡張性、R9 独自 UI、R10 依存が小さい、R11 a11y（キーボード / SR）、R12 メモリとデータ安全、R13 観測に内容を出さない。

| 候補 | 判定 |
| --- | --- |
| **CodeMirror 6** | **推奨**。R1–R10 を満たす。diff は `@codemirror/merge`。 |
| Monaco | 却下。R2（公式にモバイル非対応）と R6（フル約 2.9MB）。IDE 機能は R3 で不要。 |
| monaco-vscode-api / modern-monaco | 却下。さらに重く、更新が複数リポジトリ。 |
| Ace | 却下。CM6 に対する利点が無い。 |
| prism-code-editor | 却下。1000 行超で遅い（R4）。 |
| @pierre/diffs | 単体では却下。diff 特化で編集は実験的。 |
| **自作**（textarea + overlay） | 却下（v1）。IME・undo・選択・a11y・長いファイル・モバイルを自前で持つ。要件が「小さな入力」に縮んだら再検討。 |

詳細と出典: `work/research/editor-selection.md`。実装時に lazy chunk のサイズを測り、350KB を超えるなら拡張を削る。非機能の目標は下の NFR 表で固定する。

### 決定 4: 保存は 0157 の REST

- 保存: **0157 の content 面**（REST。パスは 0157 で確定）に `{ content, expectedVersion, operationId }`。0106 が勝手にパスを決めない。
- `applied` → buffer を clean にし、version を更新。`conflict` → サーバの内容を保持し、diff と「再読込 / 上書き」を出す。`unknown` → 再読込してハッシュを比べ、同じなら applied、違えば conflict。**unknown を成功として扱わない**。
- `operationId` はクライアントで生成し、再送で同じ値を使う（冪等）。
- 上書きは「最新の version を取得 → その version で保存」の2段。version を捨てた force 保存はしない。

### 決定 5: dirty guard と URL

- パネルを閉じる / 会話を移る / ホームへ戻る / プロジェクトを切り替える前に、dirty なら確認する。確認後は buffer を捨てる。
- 開閉とファイルは URL に入れる（`?file=<path>`）。戻る / 進むで戻る。モバイルは全画面。

### 決定 6: 状態と diff

- 読み込み中 / 空 / 読めない / binary（NUL を含む）/ 長い（上限超えは read-only の preview）/ 保存中 / 競合 / unknown。
- diff は行単位の LCS。gutter は自前（Monaco は使わない）。上書き前に diff を見せる。

### 非機能要件（NFR）

性能・信頼性・a11y・モバイル・セキュリティ・運用を、実装前に測定可能な形で固定する。全画面の共通 baseline は [docs/web-client-nfr.md](../../docs/web-client-nfr.md)（初期 JS ≤250KB gzip、現在 208.9KB）。

| ID | 要件 | 目標 / 測り方 |
| --- | --- | --- |
| NFR-P1 | 初期バンドルに editor を含めない。開いたときに lazy load | editor chunk は **≤350KB gzip**（core + commands + `@codemirror/merge`。言語パックなし）。build の出力で確認 |
| NFR-P2 | ファイルを開いて編集できるまでの時間 | ≤256KB のファイルで **p95 ≤500ms**（local。read + CM6 init） |
| NFR-P3 | 入力の遅延 | キー入力 → paint **p95 ≤16ms**。入力中に 100ms 超の long task を出さない |
| NFR-P4 | 保存の応答 | 保存 → 結果 **p95 ≤1s**（local）。押下 100ms 以内に saving 表示 |
| NFR-P5 | tree の表示 | 初回 / 展開 **p95 ≤300ms**（≤500 entry のディレクトリ） |
| NFR-P6 | アプリ全体の初期表示を悪化させない | 0102 の LCP / TTI の予算を変えない（editor は初期 chunk に入れない） |
| NFR-P7 | メモリ | 1MB のファイルで editor の追加メモリ ≤100MB。パネルを閉じたら解放 |
| NFR-R1 | 保存の結果を偽らない | applied / conflict / unknown を区別。失敗・不明で「保存済み」を出さない。buffer は残す |
| NFR-R2 | 切り替え中の要求 | ファイル / プロジェクト / 会話の切り替えで古い read / save を abort。別ファイルへ書かない |
| NFR-R3 | データを黙って捨てない | dirty で閉じる / 移る / 戻る / リロードは確認。v1 は draft の自動保存をしない（落ちたら失うことを明示） |
| NFR-A1 | アクセシビリティ | WCAG 2.2 AA。キーボードだけで tree → 開く → 編集 → 保存 → 競合 / diff を辿れる。focus 管理、ラベル、コントラスト、reduced motion |
| NFR-M1 | モバイル | 全画面、タッチ対象 ≥44px、IME / 仮想キーボード、hover 前提の操作をしない（0113 と実機） |
| NFR-S1 | セキュリティ | CSP。eval / リモートコード / 言語サービス Worker なし。本文はテキストとして描画（HTML 注入しない）。本文・パスをログ / metric に出さない |
| NFR-O1 | 運用の観測 | 開く / 保存 / 競合 / unknown / error の回数と latency を 0162 / 0163 に送る。内容は送らない |
| NFR-C1 | 対応環境 | Chrome / Safari / Firefox の現行、iOS Safari。UTF-8 のみ。改行（CRLF / LF）は保存で変えない。binary は read-only。8MiB 超は read-only / 拒否 |
| NFR-T1 | 性能の固定 | 性能は CI の合否にしない。issue に before / after を残し、0113 の実機確認とゲートの実測で固定する |

### 決定（D092）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | content の面 | REST（0157）。tree / search は GraphQL（0125） | 0125 / 0157 | このレビュー |
| U-02 | unknown の扱い | 再読込してハッシュ照合。成功扱いにしない | 0157 | このレビュー |
| U-03 | 上書きの意味 | 最新 version を取得して保存（force しない） | 0157 / 0106 | このレビュー |
| U-04 | binary / 長いファイル | binary は編集しない。長いものは read-only preview | 0125 / 0157 | このレビュー |
| U-05 | URL の形 | `?file=<path>` | 0105 / 0106 | このレビュー |
| U-06 | エディタの選定 | **決定（user / 暫定）**: CM6。Monaco / Ace / Prism / Pierre / 自作は却下。NFR を満たさない場合は再判断 | 0106 / lock / D043 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | open → loaded → edit → dirty。保存 → applied → clean | 高 | 受入1・2 |
| C2 | 保存中に edit → applied 後も新しい編集は残る（version で照合） | 高 | 受入2 |
| C3 | conflict → サーバの内容を保持し、diff と再読込 / 上書き | 高 | 受入3 |
| C4 | unknown → 再読込 → 同じなら applied、違えば conflict。成功扱いにしない | 高 | 受入3 |
| C5 | dirty で閉じる / 会話を移る / 戻る → 確認。確認後は buffer を捨てる | 高 | 受入4 |
| C6 | URL で開閉 → 戻る / 進む。モバイルは全画面 | 中 | 受入5 |
| C7 | 空 / 読めない / binary / 長い → それぞれの表示。編集不可 | 中 | 受入6 |
| C8 | 同じ operationId の再送 → 同じ結果（二重保存しない） | 高 | 受入3 |
| C9 | `npm run check` | 高 | — |
| C10 | build → editor が初期 chunk に無く、lazy chunk が ≤350KB gzip | 中 | NFR-P1 |
| C11 | 計測 → open p95 ≤500ms、save p95 ≤1s（issue に表を残す） | 中 | NFR-P2・P4 |
| C12 | 入力の long task → 100ms 超が無い（PerformanceObserver） | 中 | NFR-P3 |
| C13 | キーボードのみ → tree / 開く / 保存 / 競合 / diff を完了できる | 高 | NFR-A1 |
| C14 | モバイル実機 → 全画面・44px・IME・キーボードで保存できる | 高 | NFR-M1 |
| C15 | ファイル切替 → 古い read / save が abort され、別ファイルに書かない。metric に本文が無い | 高 | NFR-R2・S1・O1 |

層は unit（buffer の状態機械 / diff / guard）と web の component テスト。保存の実経路は 0157 の integration。性能・a11y・モバイルは 0113 / 0162 / 0163 と実機で確認する。

## Log

- 2026-11-17: D092 で合意。U-01〜U-06 を決定し、`design: agreed` にした。CM6 は暫定。

## やらないこと

- ファイルツリーの大規模検索（0125）
- Git 操作（Want）
- 複数ファイルのタブ

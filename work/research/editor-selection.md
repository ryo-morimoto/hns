# エディタの選定（0106 U-06 の比較）

2026-11-17 / lead。0106 の右パネルで使うエディタを、要件から比較する。

## なぜ「CM6 で決定済み」に見えたか

- docs/engineering.md の表に「CodeMirror 6 / 軽い。diff は自前 / Monaco（重い）」の1行があり、D043 も「CodeMirror 6 は 0106 で exact pin と理由をこの decision に追記する（engineering で選定済み）」と書いている。
- 0106 の設計はそれを前提として繰り返した。**要件から比較した記録が無い**のが問題で、選定自体は再検討してよい。

## 要件（0106 と web の制約から）

| ID | 要件 | 重み |
| --- | --- | --- |
| R1 | 会話画面の右パネルで動く。React 19、jsdom で component test が書ける | 必須 |
| R2 | モバイル（タッチ選択・仮想キーボード・IME）で編集できる | 必須 |
| R3 | 任意のテキストファイルを編集する。言語サーバー / 補完は不要 | 必須 |
| R4 | 行番号・Tab・⌘S・read-only。長いファイルで固まらない | 必須 |
| R5 | 競合時の行単位 diff。diff 専用製品ではない | 必須 |
| R6 | lazy chunk が軽い（目安: gzip 350KB 以下）。Workers Assets で配る | 高 |
| R7 | CSP と供給網: eval / リモートコード / 言語サービス Worker を足さない。exact pin | 高 |
| R8 | 保守が続き、TypeScript 型があり、装飾・テーマを深く拡張できる | 高 |
| R9 | 独自 UI（CSS 変数のテーマ、diff gutter）に馴染む | 中 |
| R10 | 依存が小さい。複数リポジトリのパッチを追わない | 中 |
| R11 | a11y: キーボードだけで開く・保存・競合・diff を辿れる。SR ラベル | 必須 |
| R12 | メモリとデータ安全: 1MB で追加 ≤100MB、失敗で buffer を失わない | 高 |
| R13 | 観測: 本文・パスをログ / metric に出さない。CSP で eval なし | 高 |

## 候補

| 候補 | R2 モバイル | R4 長いファイル | R6 サイズ | R8 保守 / 拡張 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **CodeMirror 6** | 対応（contenteditable ベース） | 大きいファイルに強い | モジュール分割。必要な分だけ | 活発。TS 型。装飾 / テーマ / `@codemirror/merge` | **採用** |
| Monaco | **公式に非対応**（タッチ選択が未解決） | 強い | フル約 2.9MB / コア約 800KB | IDE 機能は強みだが、公開 API は `monaco.d.ts` の範囲。Worker 設定が要る | 却下（R2 / R6） |
| monaco-vscode-api | 同上 | 同上 | さらに重い | VS Code のソースを取り込みパッチ。更新が複数リポジトリ | 却下 |
| modern-monaco | 同上 | 同上 | 同上 | 開発中で API が変わり得る | 却下 |
| Ace | 部分的 | 中 | 中 | 古いモードが多い。CM6 に対する利点が無い | 却下 |
| prism-code-editor | 対応 | **1000 行超で遅い** | 小さい（3KB コア） | 小さい入力欄向け | 却下（R4） |
| @pierre/diffs | — | — | 中 | diff 特化。編集は実験的 | 単体では却下。diff の参考 |
| **自作**（textarea + overlay + 行番号 + diff） | 自前で保証 | 自前 | 最小 | 選択・undo・IME・a11y・長いファイル・モバイルを全部自前 | 却下（v1）。要件が「小さなテキスト入力」に縮んだら再検討 |
| Caret 等の新興 | 不明 | 不明 | 小 | 実績が無い | 却下 |

## 判断

- **R2（モバイル）と R6（サイズ）が Monaco を落とす。** IDE 機能（補完・診断）は R3 で不要なので、Monaco の強みが要件に効かない。
- **自作は「編集」の非機能要件（IME・undo・選択・a11y・長いファイル・モバイル）を全部自分で持つ**ことになる。R11（a11y）と R2（モバイル）を満たすには CM6 と同等の実装量が要り、v1 で自作する理由がない。
- CM6 は R1–R10 を満たす唯一の候補。diff は `@codemirror/merge` で足り、Pierre を別途足す必要はない。
- 結論: **CodeMirror 6**。pin は `@codemirror/state` / `view` / `commands` / `language` / `merge` を exact。言語パックは v1 では足さない（R3）。

## 残る確認

- 実際のバンドルサイズ（lazy chunk）を実装時に測る。500KB を超えるなら言語パックと拡張を削る。
- モバイルの IME / タッチ選択を 0113 の実機確認に含める。
- 自作にするなら、要件を「diff の閲覧 + 小さな編集」に絞った別 issue にする。

## 出典

- ユーザー提供の比較（2026-08〜10 の記事）: [pistack](https://www.pistack.xyz/posts/2026-08-22-browser-code-editors-monaco-codemirror-ace-comparison/)、[PkgPulse](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)、[monaco-editor issues](https://github.com/Microsoft/monaco-editor/issues)、[prism-code-editor](https://prism-code-editor.netlify.app)（外部情報。数値は実装時に再測する）
- [CodeMirror 6](https://codemirror.net/)（設計と拡張）
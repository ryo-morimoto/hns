# 0054: 同名ファイルの差し替え窓（TOCTOU の残り）

status: open
depends-on: 0005
touches: packages/workspace, docs/workspace.md, docs/safety.md

## Goal

helper が対象を hash してから rename するまでの間に、同じディレクトリの同名ファイルを差し替えられると
CAS が破れる。親の差し替えは dirfd で閉じたが、この窓は残っている。閉じるか、許容すると決めて
docs に書く。

## Acceptance criteria

- [ ] `renameat2(RENAME_EXCHANGE)` で temp と対象を交換し、交換後の旧対象を hash して expected と
      比べる方式を評価する（Node に syscall が無いため、native helper か外部コマンドが要る）
- [ ] 実装する / 許容する を決め、docs/workspace.md と docs/safety.md に反映する
- [ ] 実装する場合: カーネル非対応時のフォールバック（checks）と fail-closed の判断を書く
- [ ] 差し替えを再現する回帰テストを足す（実装する場合）

## Notes

- 現在の helper は親を dirfd で固定するが、最終コンポーネントの CAS は
  「hash → rename」の2手であり、原子的ではない。
- Node の `fs.rename` では compare-and-rename ができない。native helper を足すと配布（0006 / 0040）が増える。

## やらないこと

- `openat2(RESOLVE_BENEATH)` だけで閉じる案（0005 で棄却済み）。
- macOS / Windows の実装。

## Log

- 2026-11-07: 作成（0045 の M-4 で「残る」と書いた窓）。

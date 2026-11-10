# 0106: Editor 右パネル（CodeMirror / 保存 / 競合 / diff）

status: open
priority: plan
depends-on: 0102
touches: packages/web/src/components/Editor, packages/web/src/screens/editor, packages/web/src/styles/editor.css, packages/web/test/editor, packages/web/package.json, package-lock.json

## Goal

会話の文脈を壊さず、右パネルでファイルを見て直す。
ファイル一覧、CodeMirror 6、保存、競合の再読込/上書き、diff、dirty の確認を提供する。

## Acceptance criteria

- [ ] ファイル一覧（ルート配下、hidden 除外、検索は 0125 が入るまでクライアント filter）
- [ ] CodeMirror 6 で編集。行番号、Tab、⌘S、読み取り専用エラーの表示
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

## やらないこと

- ファイルツリーの大規模検索（0125）
- Git 操作（Want）
- 複数ファイルのタブ

# 0103: Command palette とキーボード操作

status: open
priority: next
design: agreed
design-ref: D084
depends-on: 0102
touches: packages/web/src/components/CommandPalette, packages/web/src/app/{keyboard,commands}.ts, packages/web/src/app/Shell.tsx, packages/web/test/command-palette

## Goal

Linear / Rauno から借りた、迷わない操作の入口。
⌘K / Ctrl+K で開き、現在の画面に応じたコマンドを検索・実行する。

## Acceptance criteria

- [ ] ⌘K / Ctrl+K で開閉。Esc で閉じ、元の focus に戻る
- [ ] コマンドは group / label / keywords / shortcut / run を持つ registry。画面側が追加できる
- [ ] 入力で filter、↑↓ / Home / End / Enter、aria-activedescendant
- [ ] ワークスペース / 会話 / エディタ / プロジェクト / テーマ / ヘルプのコマンド
- [ ] shortcuts help は実際のキーと一致する（H / N / J / K / Enter / ⌘K / ⌘E / ⌘S / ?）
- [ ] マウスとキーボードの両方で同じ結果。IME 中の Enter を送信扱いしない
- [ ] テスト: open/close、filter、keyboard、focus 戻し

## Notes

- fuzzy 検索の依存は足さない。label + keywords の includes で始める
- command の実行は callback。palette に API 呼び出しを書かない
- モバイルではコマンドの入口を上バー右のアイコンに置く（0102 実装済み、原則18）。⌘K が使えない端末でも同じ command に届く。composer と共存できる形は低優先度

## Design（D084 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D084）。

### 前提

- 0102 のシェルは `onOpenCommand` のスロットとモバイルの上バーアイコンを持つが、実体はまだ無い。
- web にグローバルの keyboard handler は無い（Menu の shortcut 表示だけ）。
- Base UI の Dialog が focus trap / Esc / focus 戻しを持つ。既存の `Dialog` ラッパーは trigger 前提で、コマンド用の chrome（入力 + リスト）に合わない。

### 決定案 1: command は registry、画面が追加する

- `Command { id, group, label, keywords, shortcut?, run }`。`group` は `workspace | conversation | editor | project | theme | help`。
- `CommandRegistryProvider` + `useCommands()`。画面は mount 中だけ自分の command を足す（unmount で消える）。
- グローバル command（テーマ、ヘルプ、ナビゲーション）は provider の既定。
- `run` は callback。palette から API を呼ばない（0103 の notes）。

### 決定案 2: 開閉と focus

- グローバルの `keydown` を1つ置く（`app/keyboard.ts`）。⌘K / Ctrl+K で toggle、Esc で閉じる。
- パレットは Base UI Dialog を controlled（`open` / `onOpenChange`）で使い、入力に initialFocus。Esc と focus 戻しは Base UI に任せる（自前の trap を書かない）。
- 開く前の `document.activeElement` を覚え、閉じたら（まだ DOM にあれば）戻す。
- 二重 open を防ぐ（key repeat / 連打）。

### 決定案 3: filter は includes、fuzzy 依存は足さない

- label と keywords を小文字化し、入力の語（空白区切り）を全部含むものを残す。
- 並び: label の前方一致 → label の部分一致 → keywords の一致。同点は group 順 → label 順（安定）。
- 空入力では全件を group 順に出す。0 件は「見つかりません」+ 入力の維持。

### 決定案 4: keyboard と aria、IME

- ↑↓ / Home / End / Enter。`aria-activedescendant` + `role="listbox"` / `option`。
- Enter は `event.isComposing` または `keyCode 229` のとき実行しない（IME の確定と区別）。
- 実行は1回だけ（Enter の連打・key repeat を無視）。実行後に閉じる。
- 入力中の Backspace 等は input に任せる。

### 決定案 5: shortcut は1つの表

- `SHORTCUTS` に `{ key, meta?, shift?, label }` を置き、palette の表示とヘルプが同じ表を読む。
- 対象: H / N / J / K / Enter / ⌘K / ⌘E / ⌘S / ?。画面が command を持たないキーは何もしない（preventDefault しない）。
- input / textarea / contenteditable の中では、⌘K と Escape 以外を無視する。

### 決定案 6: モバイル

- 上バー右のアイコン（0102 実装済み）で開く。パレットは全画面。
- タッチで項目を選べる。⌘K が無い端末でも同じ command に届く。

### 決定案 7: テスト

- Testing Library（jsdom）。Base UI Dialog の focus 挙動はライブラリに任せ、こちらの契約（open/close、filter、選択、IME、focus 戻し）を固定する。

### 決定（D084）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | ブラウザの ⌘K と衝突するか | **決定（user）**: パレットが開ける画面では preventDefault。開けない画面ではブラウザに任せる | 0103 | 2026-11-17 |
| U-02 | 画面に無い command の扱い | **決定（user）**: palette には出さない。ヘルプには「画面による」と出す | 0103 | 2026-11-17 |
| U-03 | ヘルプの置き場 | **決定（user）**: `?` で開くダイアログ（palette と同じ registry を読む） | 0103 / 0107 | 2026-11-17 |
| U-04 | モバイルで palette を sheet にするか | **決定（user）**: 全画面。sheet は低優先度 | 0103 | 2026-11-17 |

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | ⌘K → 開く → Esc → 元の要素に focus が戻る | 高 | 受入1 |
| C2 | 入力 → filter → 前方一致が先頭。0 件で「見つかりません」 | 高 | 受入3 |
| C3 | ↑↓ / Home / End / Enter → 選択が動き、Enter で1回だけ実行 | 高 | 受入3 |
| C4 | IME 中に Enter → 実行しない | 高 | 受入6 |
| C5 | マウスで選ぶ → キーボードと同じ command が実行される | 中 | 受入6 |
| C6 | 画面 A の command が画面 B では出ない | 中 | 受入4 |
| C7 | shortcut 表とヘルプの表示が一致する | 中 | 受入5 |
| C8 | モバイルのアイコン → 全画面の palette が開く | 中 | Notes |

## Log

- 2026-11-17: D084 で合意。U-01〜U-04 を決定し、`design: agreed` にした。

## やらないこと

- AI によるコマンド解釈
- 画面の operation を palette に全部移すこと

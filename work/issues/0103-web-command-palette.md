# 0103: Command palette とキーボード操作

status: open
priority: plan
design: pending
depends-on: 0102
touches: packages/web/src/components/CommandPalette, packages/web/src/app/keyboard.ts, packages/web/test/command-palette

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

## やらないこと

- AI によるコマンド解釈
- 画面の operation を palette に全部移すこと

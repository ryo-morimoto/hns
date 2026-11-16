# 0113: Responsive / accessibility / motion の仕上げ

status: open
priority: plan
design: pending
depends-on: 0104, 0105, 0106, 0107, 0108, 0109, 0110, 0111, 0112
touches: packages/web/src/app, packages/web/src/styles, packages/web/test/a11y

## Goal

390px からデスクトップまで、同じ Intent を保つ。
focus、キーボード、reduced motion、コントラスト、読み上げを画面横断で確認する。

## Acceptance criteria

- [ ] 390 / 768 / 1280 / 1440 で横 overflow なし。サイドバー、右パネル、composer が壊れない
- [ ] 全 interactive 要素に focus-visible。focus 順が視覚順と一致
- [ ] 主要操作（H / N / J / K / Enter / ⌘K / ⌘E / ⌘S / Esc）がキーボードで可能
- [ ] タッチ / スワイプ: 必要な操作（dismiss・drawer・行操作・タブ切替）にスワイプがあり、ボタン/メニュー/キーボードの代替とスクロール・戻るジェスチャとの非競合を満たす
- [ ] モバイルのクロームが最小（上バーはメニュー / 現在地 / コマンド、本文は全幅、フッターは composer が主）。階層の入れ子・常設タブ・下部バーがない（原則18）
- [ ] reduced motion で animation / transition を止める。色だけで状態を伝えない
- [ ] light / dark のコントラスト確認。エラー / 警告 / 成功が色以外でも分かる
- [ ] 空 / loading / error / offline / 長文 の状態を各画面で確認
- [ ] 自動テスト（render / keyboard）と手動チェックリスト

## Notes

- 新機能は入れない。見つけた問題は画面 issue に戻すか、ここで直す
- モバイルの Needs you への導線（固定ジャンプ）はここで決める
- 0036 の acceptance「キーボード操作とエラー表示」を満たす

## やらないこと

- 新しい画面
- デザインの全面変更

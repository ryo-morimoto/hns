# 0107: Settings 画面（provider / 秘密 / 制限 / backup / 観測）

status: open
priority: plan
depends-on: 0039, 0102, 0122, 0123, 0124
touches: packages/web/src/screens/settings, packages/web/test/settings

## Goal

運用者が、モデル・鍵・制限・バックアップ・観測をブラウザで確認・変更できる。
秘密は表示せず、ロック中はロックとして扱う。

## Acceptance criteria

- [ ] Provider / model: 0122 の catalog から選択。既定モデルを 0123 で保存
- [ ] Secrets: scope ごとの一覧、追加・削除。値は保存後も再表示しない。423 をロックとして表示
- [ ] Limits: turns/min、日次トークン、timeout を 0123 で read/write
- [ ] Backup: 0124 の状態、手動実行、スケジュール。復元は確認付き
- [ ] Observability: health / metrics / usage / events の要約。0039 の範囲
- [ ] 保存成功・失敗・競合・ロック・権限なしの状態
- [ ] 秘密が DOM / ログ / toast に出ないテスト
- [ ] テスト: 各セクションの read/write、423、validation

## Notes

- 1画面にセクションを並べるが、各セクションは独立した component にする
- provider の鍵は「保存済み / 未設定」だけを出し、値を返さない
- 変更は optimistic にしない。保存結果を待って表示する
- 0039 の観測画面と重複する部分は、Settings は要約だけにし、詳細は 0039 に委ねる

## やらないこと

- provider の OAuth（0122 の範囲外なら別 issue）
- バックアップの実装（0020 / 0124）

# 0120: Review evidence（変更ファイル・テスト・成果物）

status: open
priority: later
design: pending
depends-on: 0033, 0039, 0145, 0146
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test/http.test.ts, packages/workspace/src, packages/server/src, packages/server/test

## Goal

Review over Replay。実行ログを全部読む代わりに、変更ファイル・テスト結果・成果物を bounded に返す。
Needs you / Completed のカードから「何が変わったか」を開けるようにする。

## Acceptance criteria

- [ ] GET /api/work-items/:id/evidence または /api/runs/:id/evidence
- [ ] 変更ファイル: path / version / 種別（create / update / delete）/ diff の参照。本文は含めない
- [ ] コマンド / テスト: 実行コマンド、exit code、所要時間、出力の先頭 N 行
- [ ] 成果物: path / mime / size / 参照。秘密・環境変数・認証ヘッダは含めない
- [ ] 上限と pagination。大きなリポジトリでも1回で全ファイルを返さない
- [ ] 契約 / server / workspace のテスト。diff は既存の file API と整合

## Notes

- 変更の正本は workspace の journal / 版。server で推測しない
- 出力は bounded。全文ログは 0039 の観測に委ねる
- UI 0104 の完了カードと 0110 の run 詳細が使う
- まだ無い情報は「無い」と返す。空配列と未実装を混同しない

## やらないこと

- 実行の録画 / replay
- 巨大な成果物のダウンロード UI

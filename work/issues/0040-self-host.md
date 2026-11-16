# 0040: セルフホストの配布

> 前提変更: 「セルフホスト」の意味は 0140 で限定された（UI は自前、脳は Cloudflare）。

status: open
priority: plan
design: pending
depends-on: 0036, 0145, 0146
touches: packages/server, docs

## Goal

単一コマンドで起動・更新・バックアップできる配布形態にする。

## Acceptance criteria

- [ ] 単一コマンド起動（env / 設定ファイル）
- [ ] データディレクトリ・migration・バックアップ / 復元の手順
- [ ] 定期バックアップと世代管理
- [ ] アップデート手順と既存データでの起動テスト

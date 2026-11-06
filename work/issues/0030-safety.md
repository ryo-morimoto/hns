# 0030: 安全の残り（要件18）

status: done
depends-on: 0014
touches: work/poc/app, work/poc/workspace-core

## Goal

sandbox の前提を固め、残っていた小さな穴を塞ぐ。

## Acceptance criteria

- [x] bubblewrap を検出し、無ければ exec を出さない（health に理由）
- [x] `.git` への書き込みを拒否
- [x] rename 後の canonical 再確認
- [x] 復旧コードの試行制限
- [x] SSH のフラグを検証（転送なし・ホスト鍵厳格）

## Result

- `detectSandbox`、`/api/health`、`bwrap` オプション。
- `run-safety.mjs` 10/10。SSH の実接続は未検証（0005/0006 と合わせて残す）。
- 残りの一覧は [safety.md](../../docs/safety.md)。

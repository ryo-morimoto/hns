# 0056: workspace の temp を後片付けする

status: open
depends-on: 0045
touches: packages/workspace

## Goal

書き込みが conflict / unknown で終わるとき、`#removeTemp` の失敗を握りつぶしている。`.hns-tmp-*` が
root 直下に残り、watcher も無視するので気づかれないまま溜まる。後片付けを確実にする。

## Acceptance criteria

- [ ] `remove` の `Result` を確認し、失敗は `audit` に残す（黙って捨てない）
- [ ] 起動時に root 直下の `.hns-tmp-*` を掃除する。**Journal の pending intent が指す temp は消さない**
- [ ] 掃除の対象と残す条件を回帰テストで固定する

## Notes

- temp 名は内部生成の UUID（0045）。operationId とは無関係。
- 置き場所を制御用ディレクトリへ逃がす案は [docs/workspace.md](../docs/workspace.md) の限界にあるが、別の判断。

## Log

- 2026-11-07: 作成（コードレビューで `#removeTemp` の失敗が無視されているのを見つけた）。

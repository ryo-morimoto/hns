# 0023: PRF で秘密を暗号化（要件14）

status: open
depends-on: 0022, 0024
touches: work/poc/app

## Goal

passkey の PRF から導いた鍵でデータ鍵を包み、ログイン中だけ復号できるようにする。

## Acceptance criteria

- [ ] 登録時に PRF の salt を渡し、`prf.results.first` を取る
- [ ] データ鍵を PRF 鍵で包んで保存（平文はメモリのみ）
- [ ] セッション終了で復号不能になる
- [ ] PRF 非対応の端末では代替（復旧コード）

## Log

- 2026-11-06: 設計は [auth.md](../../docs/auth.md)。

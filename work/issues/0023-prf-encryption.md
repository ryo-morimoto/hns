# 0023: PRF で秘密を暗号化（要件14）

status: done
depends-on: 0022, 0024
touches: work/poc/app

## Goal

passkey の PRF から導いた鍵でデータ鍵を包み、ログイン中だけ復号できるようにする。

## Acceptance criteria

- [x] 登録時に PRF の salt を渡し、`prf.results.first` を取る
- [x] データ鍵を PRF 鍵で包んで保存（平文はメモリのみ）
- [x] セッション終了で復号不能になる（423 locked）
- [ ] PRF 非対応の端末では代替（復旧コード）

## Log

- 2026-11-06: 設計は [auth.md](../../docs/auth.md)。
- 2026-11-06: 実装。7/7 合格。

## Result

- 登録時にブラウザで DEK を作り、PRF から導いた KEK で包んで `wrappedDek` / `dekIv` を保存。
- ログイン時に開いて `/api/passkey/unlock` でセッションに渡す。DEK はメモリのみ。
- 再起動でロック（`423`）、再ログインで復号。`run-prf.mjs` が一連を確認。
- 残り: PRF 非対応端末の復旧コード。
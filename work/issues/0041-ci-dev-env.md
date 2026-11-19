# 0041: CI と開発環境の固定

status: open
priority: later
design: agreed
design-ref: 設計を変えない（CI）
depends-on: 0046
touches: work/issues/0004, .github

## Goal

開発環境を固定し、check を CI で強制する。

## Acceptance criteria

- [ ] node を固定する（0004 を閉じる）
- [ ] npm run check を CI で回す
- [ ] 可能なら E2E の主要シナリオも回す（0043）
- [ ] キャッシュと失敗時のログ

## Notes

- 優先度は低い（2026-11-07 のユーザー判断）。0042 / 0047 の後でよい。
- 0046 で決めた runner をそのまま CI で回す。CI だけ別 runner にしない。
- Node 26 の固定方法（nix か setup-node か）は 0004 の決定に合わせる。

## やらないこと

- E2E は 0043 の後。ツールは 0043 で決める。
- デプロイ・配布（0040）。

## Log

- 2026-11-11: 0031 の「CI 未接続」の受入条件を引き継いだ（0031 は done）。CI の実行内容はこの issue の受入条件が正本。

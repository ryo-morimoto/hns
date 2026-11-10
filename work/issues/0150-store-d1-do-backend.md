# 0150: store の D1 バックエンド（node:sqlite との二重化）

status: open
priority: now
depends-on: 0144
touches: packages/store/src/driver/, packages/store/test/driver/

## Goal

制御データ（Project / Task / Workflow 定義 / Machine / usage）を D1 で動かす。ローカルの `node:sqlite` はテストと開発に残す。
DO SQLite は pi-durable の内部（Session）と Workspace DO のもので、store のドライバは関与しない（D049）。

## Acceptance criteria

- [ ] ドライバ抽象（prepare / all / run / transaction）を1つ置き、2実装（node:sqlite / D1）が同じ SQL を流す
- [ ] migration runner は二重に定義せず、同じ SQL を各ドライバに適用する
- [ ] 「実 SQLite でテストする」規律を維持（ローカルは temp、D1 は miniflare の実 SQLite）
- [ ] 0/1・JSON 文字列・連番を外に出さない規則を維持
- [ ] どちらのバックエンドでも同じ `parse*` の結果になることをテスト
- [ ] 抽象化の理由（呼び口が2つ以上あること）を decision に書く

## Notes

- 0047 で作った store はそのまま活かす。SQL と `parse` は共通。
- D1 は投影（0149）、DO SQLite は会話と制御。両方を同じ store で扱う。

## やらないこと

- ORM を入れない。
- 既存のテーブル定義を変えない（必要なら migration を足す）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

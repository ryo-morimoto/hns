# 0153: R2 オブジェクトストア（git object 互換・pack アップロード）

status: open
priority: now
design: agreed
design-ref: D048, docs/durability.md §1・§5
depends-on: 0141, 0144
touches: packages/workspace/src/objects.ts, packages/workspace/test/objects.test.ts

## Goal

ワークスペースの内容を R2 に置く。key は git の object id とし、checkpoint の commit から辿れる形にする。

## Acceptance criteria

- [ ] ファイル内容は blob として content-addressed に保存（key = object id）
- [ ] checkpoint は pack 1個のアップロードにまとめる（1 Run = 1 Class A を目標）
- [ ] ack 済み保存は content を R2 に置いてから返す（0141 の ack 定義）
- [ ] 復元に必要な object の一覧を commit から辿れる
- [ ] 重複排除（同じ content は 1 回だけ）
- [ ] versioning と object lock の設定を手順化

## Notes

- コストは容量ではなく書き込み回数で決まる。個別 PUT を避ける。
- R2 をファイルシステムとしてマウントしない（rename が原子でなくなる）。

## やらないこと

- restore の実装（0155）。
- .git 全体の同期（必要になったら別 issue）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: 第2波で now へ（0154 の checkpoint と 0169 の 256KB 超の本文を開ける）。BOARD は別セッションの編集が落ち着いてから lead が反映。

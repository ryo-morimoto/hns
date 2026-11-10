# 0155: restore（base + Journal の再生）

status: open
priority: plan
depends-on: 0154
touches: packages/workspace/src/restore.ts, packages/workspace/test/restore.test.ts

## Goal

マシンを失っても、確定した状態まで戻せるようにする。何が戻って何が戻らないかを説明できる形にする。

## Acceptance criteria

- [ ] base の checkpoint を展開 → Journal の seq 順に再生 → 未確定 intent を `unknown` として照合
- [ ] ack 済みの保存が byte 一致で戻る（テスト）
- [ ] agent の shell 変更は最後の checkpoint まで戻る（それ以降は失われると明記）
- [ ] 復元先が別マシンでも root の同一性（`.hns/root.json`）を検証
- [ ] 復元手順を1ページの runbook にし、練習する（0164）

## Notes

- INV-04: 再送は既存結果を返すか照合する。盲目的に再適用しない。
- 復旧成功率 = snapshot の完全性 × replay の正しさ × 手順の練習。

## やらないこと

- バックアップの運用（0164）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

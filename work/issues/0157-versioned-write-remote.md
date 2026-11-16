# 0157: 版付き書き込みのリモート化（ack が DO を通る）

status: open
priority: plan
design: agreed
design-ref: docs/durability.md §3.1・§3.4
depends-on: 0033, 0147, 0156
touches: packages/workspace/src/files.ts, packages/server/src/routes/files.ts, packages/server/test/routes/files.test.ts

## Goal

読み書きの経路を UI → DO → マシンにし、ack の時点で Journal と内容が確定している形にする。
TOCTOU の閉じ方（dirfd・同一ディレクトリ temp + rename）はマシン側で維持する。

**読みはマシンから返す**（R2 は読みの経路に入れない。U が見えないため）。オフラインは失敗させる。

## Acceptance criteria

- [ ] `POST /workspaces/:id/files` が DO で intent を書き、マシンで適用し、outcome を書いてから 200 を返す
- [ ] `expectedVersion` はマシンで再計算して比較（DO の値を信じない）
- [ ] 応答が返らないときは `unknown`。再送で照合（INV-04）
- [ ] concurrent な保存で片方が conflict になるテスト
- [ ] 保存の p95 を記録（目標を決める）
- [ ] 読みはマシンから。切断中は「読めない」を返し、古い内容を返さない
- [ ] 外部変更（agent の shell）を検知したら、版の不一致として扱い UI に出す

## Notes

- ack が DO を通るので、ローカル fsync に依存せずに RPO 0 を満たせる。
- ただし git / bash 由来の変更はここを通らない（checkpoint 0154）。

## やらないこと

- バッチ保存（0055）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

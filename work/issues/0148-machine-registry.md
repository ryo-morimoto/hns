# 0148: Machine レジストリ（D1 + fetch）

status: open
priority: plan
design: pending
depends-on: 0147
touches: packages/server/src/machines/, packages/core/src/machine.ts, packages/store/src/migrations/d1/

## Goal

登録されたマシンと、いま届くかを D1 のレコードで保つ。
cloudflared は外向きの接続を維持する（D053）が、machine の状態は D1 のレコードで足りるので、接続を保持する DO は作らない（D049）。

## Acceptance criteria

- [ ] `Machine(id, name, hostname, publicKey, agentVersion, lastSeen, status)` を D1 に持つ
- [ ] 登録はブラウザのセッションから行い、公開鍵を保存する（秘密はマシンから出ない）
- [ ] 失効は即時に効く（以後の署名を拒否）
- [ ] 疎通は署名付きの health 呼び出しで確かめ、結果を遅延書き込みする（毎回の同期更新をしない）
- [ ] 同名・再イメージ・二重接続の扱いを決めてテストする
- [ ] 切断中の Run は park し、再接続で照合する（INV-04）
- [ ] 一覧は D1 から直接引く（索引を作らない）

## Notes

- 接続は cloudflared のトンネル。ホスト名の管理はここ。
- PoC は固定の `AGENT_URL` 1本。DO を使っていないのがそのまま正しい形。
- 状態の更新（lastSeen）は書き込み回数が増えるので、間引く。

## やらないこと

- 新しいマシンの初期化（clone・鍵・ツール導入）。A' に上げる条件。
- 常駐サービスとプレビュー。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: DO をやめ、D1 + fetch に変更（D049）。

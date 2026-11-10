# 0141: 耐久の契約（ack の故障クラス・checkpoint・restore）

status: in-progress
priority: now
depends-on: 0140
touches: docs/durability.md, docs/workspace.md, packages/core/src/durability.ts

## Goal

「保存した」と言ったあと、どの故障まで耐えるかを決めて型と文書にする。
checkpoint の単位と restore の手順を、以後の実装が迷わない形で固定する。

契約は [docs/durability.md](../../docs/durability.md) に書いた。正本は `(C, J)`（最後の checkpoint と、
その後の確定済み Journal）。作業ツリーは写像であり、失ってよい。

## Acceptance criteria

- [ ] 故障クラス表: プロセス crash / 電源断 / マシン喪失 / アカウント事故 のそれぞれで何を保証するか
- [ ] ack の意味: エディタ保存は DO と R2 の確定後、agent の shell 変更は Run 終了時の checkpoint まで
- [ ] durable の単位は `(C, J)`（checkpoint commit と、その後の確定した Journal）と定義
- [ ] restore の順序: base の展開 → Journal の seq 順再生 → 未確定 intent を `unknown` として照合（INV-04）
- [ ] RPO の数値目標（ack 済み 0 / agent 変更は Run 時間）を文書に書く
- [ ] `docs/workspace.md` の「rename の耐久性を保証しない」を、誰がいつ埋めるかに置き換える
- [ ] `docs/durability.md` を正とし、Session DO / Workspace DO の分担を core の型に落とす
- [ ] INV-09（正本は (C, J)）と INV-10（ack は単一システム）を ARCH に足す（0140 と調整）

## Notes

- いまの実装はディレクトリ fsync をしないため、ack 直後の電源断で保存が消え得る。R2 はそこを解決しない（消えたものは送れない）。
- checkpoint は `git stash create` 相当の commit を `refs/hns` に作る。ユーザーのブランチは動かさない。
- `.gitignore` 対象（node_modules / build）は含めない。

## 未確定

- U-25: 解決済み（D048）。checkpoint は Run の終了時（中断・lease 解放・正常終了を含む）。定期 checkpoint はしない。

## やらないこと

- R2 の実装（0153）と restore の実装（0155）。
- provider の鍵（0143）。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: 契約を [docs/durability.md](../../docs/durability.md) に書いた（`(C, J)`・ack の順序・checkpoint の契機・費用の見方）。残りは core の型と workspace.md の更新。

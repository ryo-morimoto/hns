# 0167: リモート経路の故障注入（intent / apply / outcome）

status: open
priority: plan
depends-on: 0157, 0169
touches: packages/workspace/test/fault/, packages/server/test/fault/

## Goal

保存の経路がネットワークを跨いだので、死ぬ場所が3つに増えた。
0002 がローカルでやったことを、Workspace DO とマシンのあいだでやる。

## Acceptance criteria

- [ ] intent の後・送信前に落とす → 再送で一度だけ適用される
- [ ] 適用後・outcome 前に落とす → ハッシュ照合で applied に落ちる
- [ ] 他者が先に書いた場合 → conflict。applied にも unknown にもしない
- [ ] outcome の後・応答前に落とす → 同じ operationId で同じ結果（二重適用なし）
- [ ] R2 への PUT の後・outcome 前に落とす → 孤児 blob が出るが、参照されないだけで壊れない
- [ ] checkpoint の最中に落とす → watermark が書かれていなければ J は残り、restore は C に戻る
- [ ] 各ケースを実際に落として再現する（モックにしない）

## Notes

- 3つの窓は [durability.md](../../docs/durability.md) §3.1 の表。
- `unknown` を丸めないことが受入条件の中心。丸めた瞬間に INV-04 が壊れる。
- 0002 の故障注入の形（kill して再起動）をそのまま使える。

## やらないこと

- ネットワーク分断の長時間試験（別 issue。0147 の再接続で扱う）。
- 負荷試験。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions.md) と [durability.md](../../docs/durability.md) を契約として）。

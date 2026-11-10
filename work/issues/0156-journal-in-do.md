# 0156: Workspace DO の骨格（lease・版・所有）

status: open
priority: plan
depends-on: 0142, 0145
touches: packages/server/src/do/workspace.ts, packages/server/test/do/workspace.test.ts

## Goal

1 ワークスペースに 1 つの Durable Object を置き、**書き込みの直列化点**にする。
lease（0142）と版の表を実装し、Session DO から RPC で呼ばれる側になる。

## Acceptance criteria

- [ ] `Workspace(id)` の DO を作る。id は workspaceId
- [ ] lease の取得・更新・解放。epoch を発番し、古い epoch の書き込みを拒否する
- [ ] lease の期限切れは fail closed（書き込みは `lease_expired` で拒否）
- [ ] `path → 現在の版` の表を持ち、`expectedVersion` の比較をここで行う
- [ ] Session DO から呼ぶ RPC の面を最小に固定（apply / read / lease）
- [ ] 直列化: 同じパスへの書き込みが同時に来たら、片方だけが通る（テスト）
- [ ] 期限切れ・二重取得・別マシンの epoch を弾くテスト

## Notes

- 版の表はキャッシュ。マシンの実測と食い違ったら「外部変更」として扱う（0157）。
- lease の型は 0142 が core に置く。ここは実装だけ。
- 分岐1（D048）の結論。Journal は [0169](0169-journal-truncation.md) に分けた。

## やらないこと

- Journal の append / 切り詰め（0169）。
- ファイルの実体（0157）。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions.md) と [durability.md](../../docs/durability.md) を契約として）。
- 2026-11-07: 0556 から分割。Journal は 0169 へ。

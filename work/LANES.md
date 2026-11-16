# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-17 時点。

## 現在

`now` は 3 件（0169 / 0220 / 0227）。0059（c55fc2d）、0153（37f5f1d）、0147（4fa4238）、0159（4fa4238）は done で main に統合済み。
0169 / 0220 / 0227 は開始待ち（owner 未割当）。0048 / 0049 / 0103 / 0149 / 0152 / 0154 / 0157 / 0162 / 0163 / 0182 / 0198 は順番待ち。

| レーン | issue | 所有するパス | owner / reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- |
| E22 | [0169](issues/0169-journal-truncation.md) Journal の切り詰め | `packages/server/src/do/journal.ts`, `packages/store/src/journal/`, `packages/server/test/do/journal.test.ts` | 未割当 / 未割当 | 開始待ち | 1 |
| E23 | [0220](issues/0220-capability-contract.md) capability 契約 | `packages/core/src/capability/`, `packages/core/{package.json,tsdown.config.ts}`, `docs/packages.md` | 未割当 / 未割当 | 開始待ち | 1 |
| E24 | [0227](issues/0227-sandbox-hardening-spike.md) sandbox 追加硬化の実測 | `work/research/sandbox-hardening.md`, `packages/workspace/test/integration/sandbox-hardening.test.ts`, `work/poc/sandbox-hardening/` | 未割当 / 未割当 | 開始待ち | 1 |

- 0059 / 0147 / 0159 は done。0153 は開始時に owner / reviewer を書く。
- 0156 が `tools/deploy/` を解放。0160 / 0161 / 0157 が次に使える。
- **design 軸（D076）**: `now` は `design: agreed` かつ依存充足。0043 / 0048 / 0049 / 0103 / 0149 / 0152 / 0154 / 0157 / 0160 / 0162 / 0165 / 0181 / 0182 / 0191 / 0194 / 0198 / 0199 は順番待ち、設計待ちは 0 件。
- **D077**: 0159 は done だが、chat の送信（`send` / `accepted` / `rejected`、`clientMessageId`）は未実装。残りは 0105 が持つ（touches に core/stream と server/ws を足した）。REST POST は作らない。
- lead は review と統合、BOARD / LANES の更新を持つ。

## 統合待ち

- なし（0147 / 0159 は 4fa4238 で done）。

## 次の変更レーン候補

- **順番待ち（design: agreed・依存充足）**: [0048](issues/0048-store-identity.md)、[0049](issues/0049-agent-conversations.md)、[0103](issues/0103-web-command-palette.md)、[0149](issues/0149-d1-projection.md)、[0152](issues/0152-real-provider.md)、[0154](issues/0154-checkpoint-commit.md)、[0157](issues/0157-versioned-write-remote.md)、[0162](issues/0162-observability-hops.md)、[0163](issues/0163-cost-and-limits.md)、[0182](issues/0182-surface-inventory.md)、[0198](issues/0198-graphql-mutation.md)。
- **依存待ちの agreed**: 0038 / 0106 / 0122 / 0125 / 0127 / 0148 / 0155 / 0166 / 0167 / 0168（依存が解けたら）。
- **設計待ち**: [BOARD.md](BOARD.md) の 7 件。設計レビュー（D069 の設計層）で `design-ref` を書いて `agreed` にしてから。
- **code mode（設計レビュー後）**: 0199 → 0200 / 0201 → 0202 →（0216、0203 → 0214）→ 0215（0105 の後）。0199 が `agreed` になるまで実装レーンを開かない。
- **D091（設計済み）**: 0220 / 0227 は `now`。0220 → 0221 / 0223 / 0225 → 0222（0221 の後）→ 0224（0223 / 0148 の後）→ 0226。0225 は 0148 / 0194 の後。0228 / 0229 は 0198 / 0160 の後。`packages/agent/src/tools.ts` は 0221 / 0226、`packages/server/src/do/session.ts` は 0203 / 0222 / 0224 / 0226 と共有するため、code mode と同時に流さない。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
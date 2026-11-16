# 0142: lease と fencing（版チェックの委譲）

status: open
priority: now
depends-on: 0141
touches: packages/core/src/lease.ts, packages/core/src/lease.test.ts, packages/core/src/index.ts, packages/core/README.md, packages/core/CHANGELOG.md, docs/durability.md, docs/workspace.md, work/issues/0142-lease-fencing.md

## Goal

正本が DO にあっても、`git checkout` や `npm install` の書き込みに毎回 RTT を払わずに済む形にする。
書き込み権を lease でマシンに委譲し、期限切れは fail closed にする。

## Acceptance criteria

- [ ] lease の型（workspaceId / machineId / epoch / expiresAt）を core に置く
- [ ] lease 保持中は今のローカル版チェック（dirfd + hash）をそのまま使うと明記
- [ ] 期限切れ・未取得では書き込みを拒否（既存の `Workspace.mode === "checks"` を雛形にする）
- [ ] 別マシンからの書き込みを epoch で拒否する条件を書く
- [ ] 同一 workspace を2台から同時編集できないことを、要件2の読み方として明記

## Notes

- lease が切れたら「書けない」で止める。ローカルに2つ目の正本を作らない。
- 読み取りは lease 不要。

## やらないこと

- lease の実装（0156 / 0157）。
- 複数マシン同時編集の調停（やらない）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: ユーザーの判断で `now` のまま最初に閉じる。touches を 0141 の形（test・index・README・CHANGELOG・docs）に合わせた。3本の同時実行（0190 / 0151 / 0147）とはファイルが交わらない。

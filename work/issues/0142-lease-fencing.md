# 0142: lease と fencing（版チェックの委譲）

status: done
priority: now
depends-on: 0141
touches: packages/core/src/lease.ts, packages/core/src/lease.test.ts, packages/core/src/index.ts, packages/core/README.md, packages/core/CHANGELOG.md, docs/durability.md, docs/workspace.md, ARCH.md, work/issues/0142-lease-fencing.md

## Goal

正本が DO にあっても、`git checkout` や `npm install` の書き込みに毎回 RTT を払わずに済む形にする。
書き込み権を lease でマシンに委譲し、期限切れは fail closed にする。

## Acceptance criteria

- [x] lease の型（workspaceId / machineId / epoch / expiresAt）を core に置く
- [x] lease 保持中は今のローカル版チェック（dirfd + hash）をそのまま使うと明記
- [x] 期限切れ・未取得では書き込みを拒否（既存の `Workspace.mode === "checks"` を雛形にする）
- [x] 別マシンからの書き込みを epoch で拒否する条件を書く
- [x] 同一 workspace を2台から同時編集できないことを、要件2の読み方として明記

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | core の `WorkspaceLease` → 4 フィールドを見る → workspaceId / machineId / epoch / expiresAt があり、expiresAt は IsoTimestamp | 中 | 受入1 |
| C2 | `LEASE_REFUSALS` → 列挙 → 未取得・期限切れ・古い epoch の3つで、追加は契約変更 | 中 | 受入3・4 |
| C3 | docs/durability.md §3.4 → 読む → 取得/更新/解放は DO、保持中はローカル版チェック、fail closed、epoch 拒否、読み取り不要、要件2 の読み方が揃う | 高 | 受入2–5 |
| C4 | ARCH と docs/workspace.md → 読む → INV-13 と「2台から同時編集しない」があり、workspace.md の未決から lease が消えている | 中 | 受入5 |
| C5 | 全変更 → `npm run check` → 通る | 高 | Result |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C2 | 契約語彙と brand の固定 | static / unit | `packages/core/src/lease.test.ts`（`expectTypeOf` + 語彙） |
| T2 | C3–C4 | 文書の突合 | manual | 独立レビューで docs / ARCH / issue を照合 |
| T3 | C5 | ゲート | static / build | `npm run check` |

## Notes

- 実装は 0156（DO の lease 発行・版の表）と 0157（ack の経路）。0142 は型と規則だけ。
- `WorkspaceLease` の `epoch` は number（発行のたびに増える）。brand は付けない（同じ数が別の意味で交わらない）。
- 拒否の語彙は snake_case（0156 の `lease_expired` に合わせる）。
- lease が切れたら「書けない」で止める。ローカルに2つ目の正本を作らない。
- 読み取りは lease 不要。

## Result

- verdict: **PASS**（初回 BLOCKED: blocking 1 / 低 8 → 修正 460c00b → 再レビュー PASS）
- reviewer: reviewer-0142（この変更を書いていない別エージェント）
- HEAD: 460c00b（初回判定 aa4249b）
- blocking: 1 件（§3.4 が古い epoch を「拒否」と「unknown」の両方に書き、ack が DO を通るかも曖昧だった）→ 修正済み
- 受入: 5/5。`npm run check` exit 0（351 tests / 70 files、28.7s）
- 非 blocking（低 8。0156 / 0157 の実装時に解釈を確定する）: 取得と更新の区別、更新で epoch を増やすか、期限切れ時の shell、stale lease の対象を ack 付き書き込みに限定、C4 の文言、DO の表がキャッシュであること、要件2 の相互参照、本 Result の記録。

## やらないこと

- lease の実装（0156 / 0157）。
- 複数マシン同時編集の調停（やらない）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions/D047.md) の採用を受けて）。
- 2026-11-17: ユーザーの判断で `now` のまま最初に閉じる。touches を 0141 の形（test・index・README・CHANGELOG・docs）に合わせた。3本の同時実行（0190 / 0151 / 0147）とはファイルが交わらない。
- 2026-11-17: 実装。core に `WorkspaceLease` / `LEASE_REFUSALS`（+ index / README / CHANGELOG）、docs/durability.md §3.4、ARCH の INV-13 と要件2の読み方、workspace.md の未決を更新。
- 2026-11-17: 独立レビュー BLOCKED（blocking 1・低 8）。blocking: §3.4 が「古い epoch は拒否」と「unknown」を併記し、ack が DO を通ることも曖昧。§3.4 を「委譲は版チェックだけ、ack は §3.1 のまま」「古い epoch は `lease_epoch_stale`、`unknown` は outcome 欠落だけ」に修正。低も反映: issue 番号の除去、`expectTypeOf` で brand を固定、Notes の統合、要件2 の重複を 2 箇所に、取得競合と接続断の規則を追加。
- 2026-11-17: 再レビュー PASS（HEAD 460c00b、blocking 0）。受入 5/5 で done。`npm run check` exit 0（351 tests）。

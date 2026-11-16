# 0156: Workspace DO の骨格（lease・版・所有）

status: done
priority: now
design: agreed
design-ref: D048, docs/durability.md §3.4
depends-on: 0142, 0145
touches: packages/server/src/do/workspace.ts, packages/server/src/do/workspace.test.ts, packages/server/src/index.ts, packages/server/src/edge/env.ts, packages/server/test/integration/workspace-do.test.ts, tools/deploy/worker.ts, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts, work/issues/0156-journal-in-do.md

## Goal

1 ワークスペースに 1 つの Durable Object を置き、**書き込みの直列化点**にする。
lease（0142）と版の表を実装し、Session DO から RPC で呼ばれる側になる。

## Acceptance criteria

- [x] `Workspace(id)` の DO を作る。id は workspaceId
- [x] lease の取得・更新・解放。epoch を発番し、古い epoch の書き込みを拒否する
- [x] lease の期限切れは fail closed（書き込みは `lease_expired` で拒否）
- [x] `path → 現在の版` の表を持ち、`expectedVersion` の比較をここで行う
- [x] Session DO から呼ぶ RPC の面を最小に固定（apply / read / lease）
- [x] 直列化: 同じパスへの書き込みが同時に来たら、片方だけが通る（テスト）
- [x] 期限切れ・二重取得・別マシンの epoch を弾くテスト

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | lease 未取得 → apply → `lease_not_held`、版は変わらない | 高 | 受入3・AC3、durability §3.4 / INV-13 |
| C2 | lease が期限ちょうど/超過 → apply → `lease_expired`、版は変わらない | 高 | 受入3、fail closed |
| C3 | A が epoch 1 → 失効後 B が epoch 2 を取得 → A が epoch 1 で apply → `lease_epoch_stale`、B の epoch 2 は通る | 高 | 受入2・3、§3.4 |
| C4 | 同じ path に expectedVersion が同じ2つの apply が同時 → 片方 applied、片方 conflict、read は勝った版 | 高 | 受入6、INV-03 |
| C5 | v1 記録済み → expectedVersion "absent" で apply → conflict（currentVersion v1）、版は v1 のまま | 高 | 受入4、INV-03 |
| C6 | lease 保持中の再取得 → 拒否、epoch は増えない。release 後の再取得 → epoch+1 | 中 | 受入2、§3.4 |
| C7 | lease 保持 → renew で期限が延び、release 後の apply は `lease_not_held` | 中 | 受入2 |
| C8 | 保持者以外の machine が現 epoch で apply → `lease_not_held` | 高 | 受入3、§3.4 |
| C9 | 未書き込み path の read → "absent"、apply 後 → 記録した版 | 中 | 受入4・5 |
| C10 | 別 workspaceId の要求 → 400 invalid_request、lease/版を汚さない | 高 | 受入1、1 workspace = 1 DO |
| C11 | 絶対パス・`..`・NUL・ドライブ表記 → 400 invalid_request | 中 | 受入4、安全境界 |
| C12 | 全変更 → `npm run check` → exit 0 | 高 | Result |
| C13 | 実 workerd の DO に RPC で acquire → apply → read → 同時 apply → release 後の旧 epoch → cf dev 再起動後の read/apply → 経路が通り、旧 epoch が拒否され、版と lease が残る（直列化の証明は C4/T3） | 高 | 受入1–6、durability §3.1–§3.4 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1・C2 | 状態遷移 + 境界値（期限ちょうど） | unit（実 SQLite） | `src/do/workspace.test.ts` "a write without a lease is refused and records no version" / "a lease fails closed at its exact expiry" |
| T2 | C3・C8 | 故障注入（古い epoch / 別 machine） | unit（実 SQLite） | "an old epoch from the previous holder is refused" / "a machine that does not hold the lease is refused" |
| T3 | C4 | 競合テスト（同一 expectedVersion の同時 apply） | unit（実 SQLite） | "only one of two concurrent writes at the same expected version applies" |
| T4 | C5 | 同値分割（一致 / 不一致） | unit（実 SQLite） | "a stale expected version conflicts without changing the table" |
| T5 | C6・C7 | 状態遷移 | unit（実 SQLite） | "a second acquisition is refused without reissuing the epoch" / "a released lease is not held and the next acquisition moves the epoch" / "renewing extends a live lease past its original expiry" |
| T6 | C9 | 契約（read の往復） | unit（実 SQLite） | "read reports absent before a write and the recorded version after" |
| T7 | C10・C11 | 契約（境界の拒否） | unit（実 SQLite） | "a write for another workspace is refused" / "an unsafe path is refused by apply and read" |
| T8 | C12 | ゲート | static / build | `npm run check` |
| T9 | C13 | 実経路の smoke + 再起動の永続 | integration（cf dev / workerd） | `test/integration/workspace-do.test.ts` "the Workspace DO serializes writes, fences the old epoch, and survives a restart"（競合行は実経路の smoke。直列化の証明は T3） |

`test/do/` は vitest.config.ts の include（`src/**/*.test.ts` と `test/integration/**`）に入らず実行されないため、unit は docs/testing.md どおり `src/do/workspace.test.ts` に置く。SQL と schema を含むので実 SQLite（node:sqlite、単一プロセス）で回す。unit では `storage.transaction` を直列化するアダプタで read-check-write の原子性を証明し、workerd 上の直列化・永続は `cf dev` の integration で確認する。

## Notes

- 版の表はキャッシュ。マシンの実測と食い違ったら「外部変更」として扱う（0157）。
- lease の型は 0142 が core に置く。ここは実装だけ。
- 分岐1（D048）の結論。Journal は [0169](0169-journal-truncation.md) に分けた。

## Result

- verdict: **PASS**（reviewer-0156、blocking 0）
- reviewer: reviewer-0156（この変更を書いていない別エージェント）
- HEAD: 36fa780（base main 2a37864。main に ff 統合）
- 受入: 7/7。`npm run check` exit 0（419 tests / 81 files、28.7s）
- 確認: lease は core の型と拒否語彙をそのまま使用（期限ちょうど `lease_expired`、再取得は epoch 据え置き、release 後 +1、旧 epoch `lease_epoch_stale`）。直列化は `storage.transaction` の read-check-write で unit が証明。deploy は dry-run で `WORKSPACE` binding と export を確認。cf dev の実 DO で再起動後も版と lease が残る。
- 既知の限界（issue に明記）: 実 deploy 先は未確認（dry-run のみ）/ 期限切れの実 workerd テストは無い（unit の時計注入で証明）/ 製品 Worker からの呼び出しは 0157（`WORKSPACE` は今は不活性）。
- 非 blocking（低 8）: 既知の限界の記載 / integration の競合行は smoke（直列化の証明は T3、変異で integration は検出しない）/ apply は intent/outcome を持たず再送が conflict → 0157 で面を拡張 / T7 の名前と本体の不一致 / session-rpc とのヘルパー重複 / integration の build が並列 2 本 / server README・package・docs/packages に Workspace を追記 / DO constructor の第 2 引数が実行時 env と同名の seam。

## やらないこと

- Journal の append / 切り詰め（0169）。
- ファイルの実体（0157）。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions.md) と [durability.md](../../docs/durability.md) を契約として）。
- 2026-11-07: 0556 から分割。Journal は 0169 へ。
- 2026-11-17: 実装前のテスト分析・設計を追加（C1–C12 / T1–T8）。touches を修正: テストは vitest の include に入る `packages/server/src/do/workspace.test.ts` に置き、DO を Worker から export する `packages/server/src/index.ts` を追加。deploy 配線（binding / export）は 0151 の main 統合後に回す。
- 2026-11-17: `Workspace` DO を実装（apply / read / lease、epoch の発番、期限切れ fail closed、版の表、`storage.transaction` による直列化）。12 unit tests（実 SQLite）を追加し、guard を壊す変異で検出力を確認。`npm run check` exit 0（100 server tests を含む）。`tools/deploy` は 0151 所有のため WORKSPACE binding と deploy 側 export は未配線。
- 2026-11-17: 0151 / 0190 統合後の main に rebase。deploy 配線を追加: `tools/deploy/worker.ts` の Workspace export、`cloudflare.config.ts` の `Workspace` export と `WORKSPACE` binding、`WorkerEnv.WORKSPACE` 型、`config.test.ts` の検証。`cf dev` integration（`workspace-do.test.ts`）で実 workerd の DO に RPC 経由で acquire → apply → read、同時 apply の片側 conflict、release 後の旧 epoch 拒否、再起動後の版 / lease 永続を確認。
- 2026-11-17: reviewer-0156 PASS（blocking 0）。既知の限界を Result に、integration の競合行を smoke として T9 に記録。main へ ff 統合（36fa780）。

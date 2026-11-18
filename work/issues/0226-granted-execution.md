# 0226: grant をツール実行に通す（agent / workspace / machine の統合）

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §3, §5, §10
depends-on: 0221, 0222, 0224, 0225, 0147, 0157
touches: packages/agent/src/runtime.ts, packages/agent/src/tools.ts, packages/agent/src/runtime.test.ts, packages/agent/src/session.ts, packages/workspace/src/protocol.ts, packages/server/src/edge/session.ts, packages/server/src/do/session.ts, packages/server/src/do/session-rpc.ts, packages/server/src/do/session-grants-store.ts, packages/server/src/do/session-grants-store.test.ts, packages/machine/src/rpc.ts, packages/machine/src/rpc.test.ts

## Intent

0221–0225 は部品で、実際のツール呼び出しにはまだ繋がっていない。agent が grant を取得し、machine が検証して実行し、Session DO が監査する一連の流れを通す。ここが Phase 1 の収束点。

## Goal

`ToolRuntime`（agent）と `GrantSource`（Session DO のローカル発行）を入れ、grant を TTL の間キャッシュする。Worker が send 時に policy snapshot を渡し、Session DO が 0224 の issuer で署名する。machine は request の `authorization` を検証し、`callHash` を再計算してから実行する。結果の `decision` を agent が監査イベントに載せる。

## Acceptance criteria

- [x] `ToolRuntime` が read / write / exec を提供し、Phase 0 の `policy` と Phase 1 の `grant` の両方を受ける
- [x] `GrantSource` が Session DO の `createGrantIssuer` と policy snapshot を使い、`(toolId, version, manifestHash, machineId)` で grant をキャッシュする。期限切れ / epoch_stale で再取得する。tool call ごとの RPC はしない
- [x] machine は `authorization` の grant を検証し、操作フィールドから `ToolCall` を再構成して `callHash` を比較する。不一致は `manifest_mismatch` / `scope_exceeded`
- [x] 成功・拒否の両方で `tool.call` / `tool.result` が監査に残る
- [x] 既存の `read_file` / `write_file` / `bash` のモデル向け JSON を変えない
- [x] Session DO に `session_grants` テーブルと `GrantLedger`（`record` / `revoke`）を実装し、発行時に記録、失効時に revoke する
- [x] Session DO は Worker から渡された snapshot の hash を検証し、revision が単調増加でなければ拒否する。モデルには渡さない
- [x] grant が無い / 検証できない環境では exec を出さない（fail closed）
- [x] `npm test -w @hns/agent`、`-w @hns/machine`、`-w @hns/server` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | agent → grant 取得 → machine 実行 → 結果と decision が返る | 高 | Phase 1 |
| C2 | 同じ grant で 2 回 → 2 回目はキャッシュを使い、grant 発行が 1 回だけ | 高 | L2 |
| C3 | grant の期限切れ → 再取得 → 実行が通る | 高 | 契約 §5 |
| C4 | machine で callHash を変える → 実行せず deny | 高 | R2 |
| C5 | scope 外の path / command → `scope_exceeded` | 高 | R3 |
| C6 | 拒否 → モデルに JSON が返り、run は落ちない | 高 | D005 |
| C7 | 成功・拒否 → 監査に call / result が残る | 高 | R4 |
| C8 | Worker / D1 が落ちて snapshot が無い → grant なし → exec を出さない | 高 | fail closed |
| C9 | grant を発行 → ledger に 1 行。revoke → 以後の検証が拒否 | 高 | 契約 §5 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C3 | fake machine + fake issuer | unit | `packages/agent/src/runtime.test.ts` |
| T2 | C4–C6 | 故障注入 + 攻撃コーパス | integration | `packages/machine/test/integration/` |
| T3 | C7–C9 | 実 Session DO + fake machine | integration | `packages/server/test/integration/` |
| T4 | C1–C8 | 実 HTTP（0147 の署名経路） | e2e | `e2e/`（該当時） |

## Notes

- 既存の `createBashTool` は `api.env` を直接使うため、grant を渡せない。`ToolRuntime` に exec を移し、bash の出力封筒は維持する。これが最も大きな変更。
- `packages/workspace/src/protocol.ts` に `authorization` を足す。既存の helper プロトコルとは別に、machine へのリクエスト封筒を定義する。
- Worker の `edge/session.ts` が D1 の active policy を読み、`session-rpc.ts` の send body に snapshot を載せる。Session DO は snapshot を保持し、モデルには渡さない。
- OpenShell の mediated channel と Codex の exec-server を参考に、per-call の認可をローカルに寄せる。TLS MITM は使わない（D090）。

## 未確定

- `packages/agent/src/tools.ts` は 0200 / 0221、`packages/server/src/do/session.ts` と `session-rpc.ts` は 0203 / 0222 と共有する。同時に流さない。

- grant のキャッシュを agent のメモリに置くか、Session DO に置くか。Phase 1 は agent のメモリ（1 会話 1 runtime）。
- epoch の push 経路。0226 では「grant の期限 + 再取得」で開始し、制御チャネルは後続。
- bash の出力を `ToolExecutionResult` のまま返すか、hns の JSON 封筒に包むか。

## やらないこと

- egress / 資格情報（Phase 2）。
- grant の署名・検証の実装（0224 / 0225）。
- UI（0229）。

## Log

- 2026-11-17: 作成（D091）。

## Result

- verdict: **PASS**（reviewer-0226。4 巡。blocking 2 → 0、修正の副作用 2 件も統合前に解消）
- HEAD: 08b7f65（main に ff 統合）。gate は exit 0（1481 tests / 1482、main で 67.8s。1 回目は cf dev の lock 競合で落ち、再実行で green）。
- **鎖**: faux モデル → `beforeTool` → `GrantSource`（cache）→ **Session DO の実 0224 issuer** → 実 WebCrypto 署名 → **machine の実 0225 verifier** → 実行 → `policy_audit` に grantId / decision。**Phase 0 への fallback は無い**（kill switch off のときだけ Phase 0）。
- **境界**: DO → machine は 0148 の control-plane 署名で出し、**grant の署名は body にだけ**（log / 例外 / 監査 / エラー応答に出さない）。`POST /rpc/conversations/<run>/tool` は **run ごとの token**（不一致 / 別 run / 失効後は 401）。**agent は grant を偽造できない**。snapshot は revision が小さいときだけ拒否（同じ revision は冪等）、hash を再計算、**モデルには渡さない**。
- **寿命**: grant は run 単位で短命。**revocation は 1 ターンの終わり**で、次の send が成功すると新しい grantId で発行し直す（revoked の ledger 行は監査の事実として残る）。**send が失敗したら終了記録を消さない**（終了ターンの grant は生き返らない）。
- **counter の正本は machine**（0225）。DO 側は監査の写しのみ。
- レビューで見つかって直したもの: 本番の transport と route の body 形の不一致（**自作 transport でテストしていたため本番が一度も通っていなかった**）/ snapshot が無いと send が 400 で全滅 / abort 後に同じ conversation が恒久的に `grant_revoked` / send 失敗時に終了ターンの grant が生き返る。
- **未実装（起動点）**: ①deploy の env 3 つ（`HNS_AGENT_URL` / `HNS_MACHINE_ID` / `HNS_CONTROL_PLANE_KEY`）②**Worker の send 面そのものが無い**ため snapshot の配線ができない ③`#transports` / `#grantPaths` / `#runTokens` は abort と object close で解放（conversation close の hook が無く、窓は grant の寿命 ≤60s）。→ [0270n](0270n-start-the-implemented-faces.md) に集約。

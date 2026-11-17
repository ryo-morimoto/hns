# 0222: ツール決定の監査を Session DO に追記する（hash chain）

status: done
priority: now
design: agreed
design-ref: D091, docs/capability.md §8, §10
depends-on: 0220, 0221
touches: packages/server/src/do/audit.ts, packages/server/src/do/session.ts, packages/server/src/do/session-rpc.ts, packages/agent/src/session.ts, packages/server/src/do/audit.test.ts, packages/server/src/do/session.test.ts

## Intent

ツールの許可・拒否は、モデルに返した後にどこにも残らない。`tool.result` の集計はあるが、どの定義・どの引数ハッシュ・どのポリシー版で決めたかを再構成できない。R4 の監査を、Session DO のローカル SQLite に hash chain で置く。D1 は使わない（DO から D1 を触らない）。

## Goal

Session DO に `policy_audit` テーブルを作り、`tool.call` を実行前、`tool.result` を実行後に追記する。各行は `prevHash` と `hash` を持ち、削除・改変・順序入替を検出できる。書き込みに失敗したら結果を返さない。読み取りは内部 RPC。

## Acceptance criteria

- [x] `policy_audit` の schema と append を `packages/server/src/do/audit.ts` に閉じる（seq / event_id / at / event / workspace_id / session_id / call_id / call_hash / args_hash / tool_id / tool_version / manifest_hash / decision_json / duration_ms / grant_id / prev_hash / hash）
- [x] `openDurableSession` が `openSession` に `onAudit`（`AuditSink`）を渡し、`tool.call` と `tool.result` を監査に書く
- [x] `tool.call` は実行前に書き、書けなければ実行しない。`tool.result` は結果を返す前に書く
- [x] `hash = sha256Hex(JCS(event から hash キーを除いたもの))`、`prevHash` は直前の hash、最初は null
- [x] `GET /rpc/policy/audit?limit=` が昇順で返す。limit は 1..200、既定 50
- [x] 生の args / 出力 / 秘密を保存しない
- [x] `npm test -w @hns/server` と typecheck が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 2 件 append → 1 件目の hash が 2 件目の prevHash と一致する | 高 | S8 |
| C2 | 1 件を削除 → 検証 → seq / hash の欠落を検出する | 高 | R4 |
| C3 | 1 件の decision を書き換え → 検証 → hash 不一致を検出する | 高 | R4 |
| C4 | 順序を入替 → 検証 → prevHash 不一致を検出する | 高 | R4 |
| C5 | 監査の append を失敗させる → tool 実行 → 結果を返さない（`AuditSink` が reject） | 高 | fail closed |
| C6 | 1 件 append → RPC → 昇順・limit・秘密なし | 中 | 契約 §8 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1, C6 | 固定イベント + fake storage | unit | `packages/server/src/do/audit.test.ts` |
| T2 | C2–C4 | 故障注入（削除・改変・入替） | unit | 同上 |
| T3 | C5 | 故障注入（append を throw） | unit | `packages/server/src/do/session.test.ts` |
| T4 | C1–C6 | 実 SQLite | integration | `packages/server/test/integration/` |

## Notes

- `onAudit`（`AuditSink`）は 0221 が `packages/agent/src/session.ts` に足す。0222 は server 側の実装と配線だけを持ち、agent の API は変えない。0221 が先（型と配線が無いとコンパイルできない）。
- 監査の書き手は Session DO 1 つ。`seq` は SQLite の AUTOINCREMENT、追記は 1 トランザクション。
- `tool.call` は「何を実行しようとしたか」、`tool.result` は「どう判定し、どれだけかかったか」。result が無い呼び出しは、落ちたか拒否されたかとして検出できる。
- OpenShell の OCSF は best-effort で hash chain を持たない（[研究](../../work/research/tool-call-fastpath-security.md) §3.7）。hns はここを改善する。OpenShell の denial の reason / policy_hash の付け方を参考にする。
- R2 への外部アンカーはこの issue ではやらない（後続）。

## 未確定

- `packages/server/src/do/session.ts` は L1 の 0203（session 配線）と共有する。同時に流さない。先に着地した側に合わせる。

- 監査の保持期間と DO の storage 上限。Phase 1 は 200 件の read と無期限 append。上限が問題になったら切り詰めではなく R2 へ退避する。
- `decision_json` の形。0220 の `PolicyDecision` をそのまま JSON にする。

## やらないこと

- D1 / R2 への書き出し。
- UI の監査画面。
- 監査の署名・外部アンカー。

## Log

- 2026-11-17: 作成（D091）。

## Result

- verdict: **PASS**（reviewer-0222。blocking 0 / non-blocking 7 + 記録 1）
- HEAD: 3a2399f（main に ff 統合）。gate は exit 0（1080 tests / 1 skip、main で 61.3s。1 回目は 0223n の既知 flake で落ち、再実行で green）。
- 確認: `policy_audit` の hash chain（`HASHED_MEMBERS` 1 箇所 + 型証明、`verify` は全行再計算で保存 hash を信じない、prevHash の連鎖と seq の連続）、append は SELECT → hash → INSERT を 1 トランザクションで冪等、`tool.call` の失敗で実行しない / `afterTool` の失敗で結果を差し替え、読取 RPC は dependencies 経由（agent の公開 API を増やさない、limit 1..200・既定 50・昇順）、拒否行は hash のキーが不在（`callHash` / `argsHash` を core で optional 化）。実経路 probe（faux → ToolTask → 実 openSession → node:sqlite → verify → RPC）と mutation 4 件（著者 2 + レビュアー 2）で検出力を確認。
- 非 blocking（follow-up）: `entryOf` の実行時の固定は型のみ / `withAudit` が拡張なしでも通る配線穴 / `denialOf` の二重実装 / テスト専用の export / 到達しない defensive code / 「秘密なし」の検査が部分一致 / list の TSDoc の clamp / T4 を `audit-probe` で代替。
- 記録: `docs/capability.md` §3 は hash を必須のまま（別セッションの未コミット）。core の optional 化は docs / decisions に未反映なので、**0220 の契約の所有者が 1 行追記**する（lead の申し送り）。

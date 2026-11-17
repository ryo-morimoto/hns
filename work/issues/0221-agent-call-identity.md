# 0221: Agent のツール呼び出しに manifest と callHash を付ける（Phase 0）

status: open
priority: now
design: agreed
design-ref: D091, docs/capability.md §3–§4
depends-on: 0220
touches: packages/agent/src/capability.ts, packages/agent/src/tools.ts, packages/agent/src/events.ts, packages/agent/src/agent.ts, packages/agent/src/session.ts, packages/agent/src/tools.test.ts, packages/agent/src/capability.test.ts, packages/agent/test/integration/bash.test.ts

## Intent

今の `workspaceTools` は、モデルが渡した引数をそのまま実行し、`tool.call` / `tool.result` にツール名と ms しか残さない。どの定義で、どの引数を、どう判定したかを後から再構成できない。Phase 0 として、ツールマニフェスト・`callHash`・判定を呼び出しに付け、監査（0222）が読めるようにする。

## Goal

`workspaceTools` が `read_file` / `write_file` / `bash` のマニフェストを組み立て、呼び出しごとに `ToolCall` / `CallDigest` を計算する。引数は strict schema で parse し、パスは root 内に正規化する。Phase 0 の既定ポリシーを pure に評価し、イベントに `callHash` / `argsHash` / `manifestHash` / `decision` / `durationMs` を載せる。grant はまだ使わない。

## Acceptance criteria

- [ ] bash の timeout は timeoutMs（safe integer）。小数の timeout（秒）は拒否し、pi-durable へはツール境界で ms→秒に変換する（JCS の safe integer 制約に合わせる）

- [ ] `read_file` / `write_file` / `bash` の `ToolManifest` を 1 箇所で組み立て、`manifestHash` を出す（説明・引数記述子・危険度・出力上限を含む）
- [ ] 各呼び出しで `ToolCall` と `CallDigest` を作り、`callId` は pi-durable の call id から取る
- [ ] 引数は `v.strictObject` で parse し、未知キーを拒否する
- [ ] `read_file` / `write_file` のパスを正規化し、root 外・`..`・絶対パスを `path_outside_root` で拒否する
- [ ] `bash` は sandbox があるときだけ登録し、Phase 0 の判定は `{kind:"exec",network:"none",writable:false}` の封筒にする
- [ ] `AuditSink`（`AuditEvent => Promise<void>`）を `WorkspaceToolsOptions` / `openAgent` / `openSession` に通し、`tool.call` は **await してから**実行、`tool.result` は await してから返す
- [ ] `tool.call` / `tool.result` に `callHash` / `argsHash` / `manifestHash` / `decision` / `durationMs` を載せ、**引数の生値は載せない**
- [ ] 拒否は例外ではなく `{ok:false,status,code,message}` の値で返す
- [ ] `npm test -w @hns/agent` と typecheck が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 3 ツールを登録 → manifest → toolId / version / risk / limits が揃い、hash が安定する | 高 | R1 |
| C2 | 同じ呼び出しを 2 回 → callHash → 同じ。引数を 1 文字変える → 変わる | 高 | R2 |
| C3 | 未知キーを含む args → parse → 拒否され、実行されない | 高 | 契約 §4 |
| C4 | `../secret` / `/etc/passwd` / symlink → read → `path_outside_root` | 高 | 0054 / 0194 |
| C5 | sandbox 無効 → tools → `bash` が無い | 高 | D025 |
| C6 | 成功・拒否 → audit event → 必要なフィールドがあり、args / 出力本文が無い | 高 | R4 |
| C8 | audit sink が reject → tool.call → 実行しない / 結果を返さない | 高 | fail closed |
| C7 | 同じ args・同じ callId → callHash が一致し、operationId も一致する | 中 | 0053 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1, C2, C7 | 固定ベクタ | unit | `packages/agent/src/capability.test.ts` |
| T2 | C3 | 異常系 | unit | `packages/agent/src/tools.test.ts` |
| T3 | C4, C5 | 境界値 + fixture | unit | 同上 |
| T4 | C6, C8 | イベントのスパイ + reject | unit | 同上 |

## Notes

- マニフェストはコードのハッシュではなく**契約のハッシュ**。実装の完全性は deploy が持つ（[capability.md](../../docs/capability.md) §4）。
- `bash` の引数は意味解析しない。Phase 0 は sandbox の封筒だけ。危険な 1 回の `exact` 承認は Phase 2（0226 以降）。
- 参考: OpenShell の MCP tool 名認可、Codex の `workspace-write`、Claude Code の deny 全モード。hns は型付きツールなので、名前だけでなく引数まで縛れる。

## 未確定

- `packages/agent/src/tools.ts` は L1 の 0200（codemode）と、`packages/agent/src/session.ts` は 0202（L1 session）と共有する。同時に流さない。先に着地した側に合わせ、後続が rebase する。

- `bash` の出力型を `ToolExecutionResult` のままにするか、agent の JSON 封筒に包むか。0226 で runtime を入れるときに決める。
- マニフェストの `version` の上げ方（ツールごとの semver か、単調整数か）。Phase 0 は `"1"` 固定。

## やらないこと

- grant の発行・検証（0224 / 0225）。
- 監査の保存（0222）。
- ポリシーの保存・承認（0223）。
- ツール runtime の抽象化（0226）。

## Log

- 2026-11-17: 作成（D091）。

## 申し送り（0221 の Result より）

- **0220 の契約（N1）**: `ToolCallAuditEvent` / `ToolResultAuditEvent` の `callHash` / `argsHash` を**拒否時のみ optional** にし、`docs/capability.md` §3 に「呼び出しが成立していない行は hash を持たない」と書く。現状は `HashSchema` が 64 hex を要求するため、拒否行（`path_outside_root` / `unsupported` / 引数不正）が parse できない。0221 は拒否行に hash を書かない（空文字も書かない）ことを選び、契約との差は `AuditRow` + `toAuditEvent` のコメントで明示している。担当は 0220 の契約の所有者。
- **0220 の flake（N7）**: `packages/core/src/capability/grant.test.ts:202`（「a signature that does not verify is grant_invalid」）が**並列負荷で 1/2〜1/4 落ちる**（単独では 3+/3 pass）。0221 は `packages/core` を 1 バイトも変えていない。**0220 宛の issue として切り出す**（統合前の gate が不安定なため）。
- **観測と監査の `decision`**: 受入 7 は「tool.call / tool.result に decision」だが、契約の `ToolCallAuditEvent` に `decision` が無いため、**観測イベントは tool.result のみ**（N6）、監査は拒否時の `decision` を持つ。契約を広げるかは N1 と同じ 0220 の判断。

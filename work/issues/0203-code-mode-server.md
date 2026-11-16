# 0203: code mode の Session DO 配線（profile RPC・sandbox access・event sink）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0202
touches: packages/server/src/do/state.ts, packages/server/src/do/session.ts, packages/server/src/do/session-rpc.ts, packages/server/src/do/session-rpc.test.ts, packages/server/src/do/session.test.ts, packages/server/test/do/, packages/server/src/ws.test.ts, packages/server/test/integration/session-do.test.ts, packages/core/src/stream.ts, packages/core/src/stream.test.ts, packages/web/src/live/state.ts, packages/web/src/live/state.test.ts, packages/web/test/live/support.ts, work/issues/0203-code-mode-server.md

## Intent

0202 の `openSession` を、製品経路の Session DO に接続する。
`@hns/machine` の exec/write はまだ無い（0194）ので、code mode は **profile と codemode の実行基盤**までを配線し、
ツールが無い code profile は「利用可能なツールが無い」とモデルに返す。ツールの実体は 0157 / 0194 の後。

## Goal

- `SessionEnv` に `CODEMODE_SANDBOX?`（別 Worker の DO namespace）を足す。
- `openDurableSession` が `RemoteCodemodeSandbox` か `disabled` を選び、`openSession({ codeMode })` に渡す。
- `session-rpc` に `setProfile` / `getProfile` を足す。
- `onCodeModeEvent` を `Session` に通し、イベント名・所要・成否だけをログに残す（本文なし）。

## Acceptance criteria

- [ ] `SessionEnv` に `CODEMODE_SANDBOX?: CodemodeSandboxNamespace` を足す（構造的型。Cloudflare 型はまだ入れない）
- [ ] `openDurableSession` は binding があれば `createRemoteCodemodeAccess({ remote: () => env.CODEMODE_SANDBOX.getByName(sessionId) })` を作り、無ければ `{kind:"disabled", reason:"no sandbox binding"}` を渡す
- [ ] `openSession` に `codeMode: { codemode, limits }` を渡す。sandbox の `close()` は 0202 の `AgentSession.close()` が行う（0203 は二重に閉じない）
- [ ] `session-rpc` に `POST /rpc/conversations/:id/profile`（`{profile}`）と `GET /rpc/conversations/:id/profile` を足す。body は `parseAgentProfile` で検証する。`CodeModeError` の `code` を 409 の `SessionRpcFailure` に写像する
- [ ] `SessionRpcFailure` の code に `profile_unavailable` / `model_mismatch` を追加する（既存の 4 値に足す。closed union を維持）
- [ ] `GET profile` は `budget`（`getBudget`）と `health`（`getModelHealth`）も返す
- [ ] `profile.toolSurface === "code"` で sandbox が無い場合、`setProfile` は `profile_unavailable`（409）を返し、profile を変えない
- [ ] `core/src/stream.ts` に `budget` / `mismatch` frame と snapshot の `budget` / `mismatch` を追加し、`LIVE_PROTOCOL_VERSION` を `2` に上げる（0215 より先に型と version を固定）
- [ ] `core/src/stream.test.ts` に protocol 2 の受理と未知 frame の拒否を追加する
- [ ] web の `applyLiveFrame` を最小追従する: `budget` / `mismatch` は状態に保持せず無視する pass-through、`state.test.ts` の `protocol: 1` を `2` に更新。本描画は 0215 が置き換える
- [ ] 既存の `protocol: 1` フィクスチャを `2` に更新する（`packages/server/src/ws.test.ts` / `packages/web/test/live/support.ts` / `packages/server/test/integration/session-do.test.ts`）
- [ ] `onCodeModeEvent` は `event.event`、`callId` / `childConversationId` / `ms`、`model.mismatch` の `scope` / `failures` をログに残す。引数・出力・プロンプトは出さない。`code.result` / `budget.exceeded` / `model.mismatch` では `getBudget` / `getModelHealth` を読み、live の `budget` / `mismatch` frame を publish する。`subagent.settle` では `getUsage(childId)` を読み、`subagent` frame の `tokens` を埋める
- [ ] `session-rpc.test.ts` に profile の取得・切替・拒否のテスト。`session.test.ts` に「binding 無し → disabled」のテスト
- [ ] `npm run check` が通る

## 設計

### 1. SessionEnv

```ts
import type { AgentProfile } from "@hns/core";
import type { CodemodeRemote } from "@hns/agent/session";

export interface CodemodeSandboxNamespace {
  getByName(name: string): CodemodeRemote;
}

export interface SessionEnv {
  readonly HNS_ENV?: string | undefined;
  readonly HNS_MODEL?: string | undefined;
  /** 別 Worker の CodemodeSandbox Durable Object。無い場合は code profile を fail closed。 */
  readonly CODEMODE_SANDBOX?: CodemodeSandboxNamespace | undefined;
}
```

`DurableObjectNamespace` は `edge/env.ts` の構造的型を再利用する（`packages/server` 内で完結）。
実際の binding は 0214。0203 は「無い場合に disabled にする」経路を先に固定する。

### 2. CodemodeAccess の選択

```ts
function codemodeAccess(env: SessionEnv, sessionId: string): CodemodeAccess {
  const namespace = env.CODEMODE_SANDBOX;
  if (namespace === undefined) {
    return { kind: "disabled", reason: "no CODEMODE_SANDBOX binding" };
  }
  return createRemoteCodemodeAccess({
    remote: () => namespace.getByName(sessionId),
    interruptBudget: 100_000,
  });
}
```

- `getByName(sessionId)` で 1 セッション 1 DO に寄せる。`sessionId` は Session DO の名前（workspace）。
- `createRemoteCodemodeAccess` / `CodemodeRemote` は `@hns/agent/session`（Worker-safe）から import する。root `@hns/agent` は Node 専用なので value import しない。server は pi-codemode を直接 import しない（package.json を増やさない）。
- sandbox の `close()` は 0202 の `AgentSession.close()` が行う。`Session` は閉じない（二重 close を避ける）。

### 3. RPC

既存の `session-rpc.ts` の route に足す。

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/rpc/conversations/:id/profile` | `{ "profile": AgentProfile }` | `{ ok: true, profile }` / 409 `profile_unavailable` |
| GET | `/rpc/conversations/:id/profile` | — | `{ ok: true, profile, budget, health }` |

- `profile` は `AgentProfile`。`limits` は 0199 の `CodeModeLimits`。`budget` / `health` は 0202 の `getBudget` / `getModelHealth`。
- 認可は edge が済ませている（0145）。RPC は公開しない。
- 不正な profile は `400 invalid_request`。存在しない会話は `404 not_found`。

### 4. event sink

```ts
onCodeModeEvent: (event) => {
  const name = event.event;
  const id = "callId" in event ? event.callId
    : "childConversationId" in event ? event.childConversationId
    : undefined;
  const ms = "ms" in event ? event.ms : undefined;
  const mismatch = event.event === "model.mismatch" ? event.scope + ":" + event.failures : "-";
  console.error("code-mode.event", name, id ?? "-", ms ?? "-", mismatch);
}
```

- `Session` は live subscriber に frame を push する internal API を持つ（0105 の WS が購読する）。ここで `budget` / `mismatch` frame を publish する。
- 本文・引数・出力は出さない（docs/observability.md）。
- D1 への永続化は 0162（イベントの製品化）に渡す。本 issue はログのみ。
- UI は 0215 で `pi.live` / WS から描く。イベント行を UI の正本にしない。

### 5. tools が無いときの code profile

- `openSession` の registry には code mode 拡張（codemode/subagent）だけが入る。`read_file` / `write_file` / `bash` は 0157 / 0194 の後。
- モデルが `tools.read_file` を呼ぶと、script は `ReferenceError` / `undefined` になる。プロンプトに「利用可能なツールは `ALL_TOOLS` を見よ」と書き、空なら「ツールが無い」と返す。
- これは一時状態。0203 の完了条件は「code profile と codemode の実行ができる」で、ツールの実体は含めない。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `CODEMODE_SANDBOX` 無し → `openDurableSession` → code profile は `profile_unavailable` | 高 | 受入2/5 |
| C2 | fake namespace あり → `openSession` に `{kind:"sandbox"}` が渡る | 高 | 受入2 |
| C3 | `GET profile` → `DEFAULT_AGENT_PROFILE` | 中 | 受入4 |
| C4 | `POST profile`（toolSurface code、sandbox 無し）→ 409、profile は変わらない | 高 | 受入5 |
| C5 | 不正 profile → 400。存在しない会話 → 404 | 中 | 受入4 |
| C6 | `onCodeModeEvent` が本文を出さない（ログ文字列に prompt / output / args が無い） | 高 | 受入6 |
| C6b | `budget` / `mismatch` frame が protocol 2 で parse でき、version 1 client は拒否 | 高 | 受入2 |
| C7 | `npm run check` | 高 | 受入8 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C2 / C3 | 同値分割 | unit | `packages/server/src/do/session.test.ts` |
| T2 | C4 / C5 | 異常系 | unit | `packages/server/src/do/session-rpc.test.ts` |
| T3 | C6 | 監査 | unit | 同 |
| T4 | C7 | ゲート | static | `npm run check` |

## Notes

- `@hns/machine` は 0147 で read/stat/list のみ。exec/write は 0194。本 issue は機械ツールを待たない。
- `RemoteCodemodeSandbox` の実配備は 0214。本 issue は binding が無い場合の fail closed を先に固定する。
- `session-rpc.ts` の body 上限は 0145 の `DEFAULT_LIMITS.maxBodyBytes` を使う。
- `SessionEnv` は secret を読まない。`CODEMODE_SANDBOX` は binding だけ。
- `openSession` の `codeMode.limits` は環境変数で変えない（まず既定）。変更は 0201 の予算 doc。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | `sessionId` を workspace 名にするか会話 ID にするか | workspace（Session DO の名前） | 0214 | lead | 0203 |
| U-02 | sandbox の `close()` の所有者 | 0202 の `AgentSession.close()`（1 回） | 0202/0203 | lead | C2 |
| U-03 | event の永続化 | 0162 に渡す。code mode はログのみ | 0215 | lead | 0215 |

## やらないこと

- sandbox Worker の配備（0214）。
- WS / GraphQL / UI（0215）。
- ツールの実体（0157 / 0194）。
- D1 の event 永続化（0162）。
- 実プロバイダ（0152）。

## Log

- 2026-11-17: 作成。0202 の `openSession` を Session DO に接続し、sandbox が無い場合の fail closed を固定する。

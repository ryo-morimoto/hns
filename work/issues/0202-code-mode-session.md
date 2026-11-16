# 0202: code mode の Session 合成（profile・codemode・subagent・budget・event）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0049, 0199, 0200, 0201
touches: packages/agent/src/session.ts, packages/agent/src/index.ts, packages/agent/src/session.test.ts, packages/agent/test/integration/session.test.ts, work/issues/0202-code-mode-session.md

## Intent

code mode の feature（0200/0201）を `openSession` に 1 回だけ合成する。
`session.ts` は 0049 と共有する直列化点なので、0200/0201 に触らせず、本 issue がまとめて配線する。
2 値の mode は使わない。保存するのは `AgentProfile`（toolSurface / subagents / limits）で、UI のプリセットはその射影。

## Goal

`AgentSession` に `AgentProfile` を足す。

- `SessionOptions.codeMode`（codemode access、limits）を受ける。
- 会話の profile を作成時に保存し、`setProfile` / `getProfile` で読み書きする。
- profile に応じて `extensions` / `modelTools` / `maxTurns` を 1 commit で切り替える。
- `toolSurface: "code"` で sandbox が無い場合は `profile_unavailable` で拒否する（黙って direct に落とさない）。
- `onCodeModeEvent` に code mode イベントを通す（保存は 0203）。

## Acceptance criteria

- [ ] `SessionOptions` に `codeMode?: CodeModeOptions` と `onCodeModeEvent?: CodeModeEventSink` を足す。`CodeModeOptions = { codemode: CodemodeAccess; limits?: CodeModeLimits }`
- [ ] `@hns/agent/session`（Worker-safe）から `createRemoteCodemodeAccess` / `CodemodeAccess` / `CodemodeRemote` / `AgentProfile` / `CodeModeLimits` / `RunBudget` / `ModelHealth` / `CodeModeError` / `CodeModeFailureCode` を export する（0203 が使う）。root `index.ts` は Node 専用なので value import しない
- [ ] `AgentSession.close()` は注入された `codeMode.codemode.sandbox` を 1 回だけ `close()` する。0203 は二重に閉じない
- [ ] `createConversation({ title, projectId, profile })` が profile を受け、`init` で `writeMetadata` と `configure(tx,id,...)` を同じ commit に書く
- [ ] `conversationCreated` で `ensureMetadata` を呼び、subagent の子を含む全 conversation に entry を保証する
- [ ] subagent の子を含む全 conversation に entry を保証する
- [ ] `conversation-metadata.ts` を import する（旧 `session.ts` 定義は 0199 で削除済み）
- [ ] `AgentSession.setProfile(id, profile)` が `ConversationMetadata.profile`（`updatedAt` も now に更新）と `pi.agent` の `extensions` / `modelTools` / `maxTurns` を 1 commit で更新する
- [ ] `AgentSession.getProfile(id)` が `AgentProfile` を返す。profile が無い既存会話は `DEFAULT_AGENT_PROFILE`。profile があれば `parseAgentProfile` で検証し、不正なら `ValiError`（既定に丸めない）
- [ ] `AgentSession.getBudget(id)` が `RunBudget | undefined`、`getModelHealth(id)` が `ModelHealth`、`getUsage(id)` が `UsageBucket | undefined` を返す（0215 / 0203 の snapshot / frame の data source）
- [ ] profile の適用:
  - `toolSurface: "code"` → codemode 拡張を add、`modelTools: [codemodeTool]`
  - `toolSurface: "direct"` → codemode 拡張を remove、`modelTools: null`
  - `subagents: true` → subagent 拡張を add
  - `subagents: false` → subagent 拡張を remove
  - `maxTurns` は code または subagents のとき `limits.maxTurns`、両方 off なら null
- [ ] `toolSurface: "code"` で codemode が `disabled`、または `codemodeTool` が undefined なら `setProfile` は `CodeModeError("profile_unavailable")` を throw し、profile を書き換えない
- [ ] 0202 が `Map<ConversationId, ModelHealth>` を所有し、連続する code / tool 失敗を数える。`MODEL_MISMATCH_THRESHOLD` で `CodeModeError("model_mismatch")` を throw し、`model.mismatch` を sink に流す。モデル変更で health をリセットする
- [ ] `send` の前に予算 controller を作り、`Turn` の後に `budget.snapshot()` を 1 回 commit する（0201 の API）
- [ ] code mode の入れ子ツール呼び出しを `ToolTask` の `beforeTool` で数え、`maxSubCalls` を超えたら block する（`call.parent` があるものだけ）
- [ ] `listConversations` は owner 付きの会話（subagent の子）を除外する。子は `getConversation` と SubagentRow から開く
- [ ] `onCodeModeEvent` に `code.*` / `subagent.*` / `budget.exceeded` / `model.mismatch` が流れる。0202 が sink を try/catch し、throw しても run を止めない
- [ ] `npm run check` が通る

## 設計

### 1. 合成点は 1 つ

```ts
export interface CodeModeOptions {
  readonly codemode: CodemodeAccess;
  readonly limits?: CodeModeLimits | undefined;
  /** dev のみ。未評価モデルで code/subagents を試す。 */
}

export interface SessionOptions {
  // 既存...
  readonly codeMode?: CodeModeOptions | undefined;
  readonly onCodeModeEvent?: CodeModeEventSink | undefined;
}
```

`openSession` の `Harness.open` 前に registry を作る（呼び出し側の registry をそのまま使う）:

```ts
const codemode = options.codeMode === undefined
  ? undefined
  : createCodeModeExtension(options.codeMode.codemode);
const codemodeTool = codemode?.tools?.find((tool) => tool.name === CODEMODE_TOOL_NAME);
if (codemode !== undefined) options.registry.install(codemode);

let Subagent: Extension | undefined;
if (options.codeMode !== undefined) {
  const subagentTool = createSubagentTool({
    budget: (conversationId) => {
      const active = activeBudgets.get(conversationId);
      if (active === undefined) throw new Error("no active budget: " + conversationId);
      return active;
    },
    subagentExtension: () => {
      if (Subagent === undefined) throw new Error("subagent extension is not ready");
      return Subagent;
    },
    codemodeExtension: codemode, // undefined でもよい（direct + subagents）
    limits: options.codeMode.limits ?? DEFAULT_CODE_MODE_LIMITS,
  });
  Subagent = defineExtension({ name: "subagent", tools: [subagentTool] });
  options.registry.install(Subagent);
}
```

- `budget` は run ごとに作るため、ツールは controller を **関数で解決**する（`(conversationId) => activeBudgets.get(conversationId)`）。`send` が `activeBudgets.set(id, controller)` し、`finally` で delete する。
- `CodeModeHooks = defineExtension({ name: "code-mode-hooks", hooks: [subcallBudgetHook], wraps: [eventWrap] })` を 0202 が作り、code または subagents のときだけ選択する。
- `session.ts` は `node:*` を import しない。`CodemodeAccess` は 0200 の Worker-safe 型。
- `openSession` は `codeMode.codemode.sandbox` を所有し、`AgentSession.close()` で 1 回だけ閉じる。0203 は閉じない。

### 2. profile の作成・切替

```ts
interface ConversationMetadata {
  // 既存...
  readonly profile?: AgentProfile; // 既存 doc は欠落 = DEFAULT_AGENT_PROFILE（JSON doc なので明示 undefined は持たない）
}
```

- `createConversation` の `init` で `const resolved = input.profile ?? DEFAULT_AGENT_PROFILE;` とし、`writeMetadata(tx, id, { ..., profile: resolved })` と `configure(tx, id, changeFor(resolved))` を同じ commit に書く（`profile: undefined` を書かない）。
- `conversationCreated` は `ensureMetadata(tx, id, fallback)` を呼ぶ。fallback は `title: "Conversation"`, `projectId: "default"`, `profile: DEFAULT_AGENT_PROFILE`。
  これで `tx.createConversation` で作られる subagent の子も index に entry を持つ。0201 が子の entry を親から上書きする。
- 既存会話で profile が無い場合は `DEFAULT_AGENT_PROFILE`（後方互換）。`setProfile` で field を追加する。
- `setProfile` は `conversation.commit(async (tx) => { const meta = ...; await writeMetadata(tx, id, { ...meta, profile, updatedAt: nowIso() }); await configure(tx, id, changeFor(profile)); })`。
- `changeFor(profile)`:

```ts
function changeFor(profile: AgentProfile): AgentChange {
  if (profile.toolSurface === "code" && codemodeTool === undefined) {
    throw new CodeModeError("profile_unavailable");
  }
  const active = profile.toolSurface === "code" || profile.subagents;
  const extensions = {
    add: [
      ...(profile.toolSurface === "code" && codemodeExtension !== undefined ? [codemodeExtension] : []),
      ...(profile.subagents && subagentExtension !== undefined ? [subagentExtension] : []),
      ...(active ? [CodeModeHooks] : []),
    ],
    remove: [
      ...(profile.toolSurface !== "code" && codemodeExtension !== undefined ? [codemodeExtension] : []),
      ...(!profile.subagents && subagentExtension !== undefined ? [subagentExtension] : []),
      ...(active ? [] : [CodeModeHooks]),
    ],
  };
  return {
    extensions,
    modelTools: profile.toolSurface === "code" ? [codemodeTool] : null,
    maxTurns: profile.toolSurface === "code" || profile.subagents ? profile.limits.maxTurns : null,
  };
}
```

- `codemodeExtension` / `subagentExtension` は `undefined` のとき配列に入れない（子が code mode を持たない場合など）。
- `toolSurface: "code"` で `codemodeExtension` または `codemodeTool` が undefined なら `CodeModeError("profile_unavailable")` を throw。profile は書き換えない。
- `subagents: true` で `subagentExtension` が undefined なら `CodeModeError("profile_unavailable")` を throw。
- 0202 が `healthByConversation: Map<ConversationId, ModelHealth>`、`modelByConversation: Map<ConversationId, Model>`、`lastBudgetByConversation: Map<ConversationId, RunBudget>` を所有する。public API は string id を受け、既存の `conversationId(id)` で numeric に変換してから Map を引く。Map は Session の in-memory で、DO 再起動で reset される。永続化しない。
- `getBudget(id)` は `activeBudgets.get(id)?.snapshot() ?? lastBudgetByConversation.get(id)`。`commitBudget` 時に `lastBudgetByConversation` を更新する。`getModelHealth(id)` は map の値を返す（無ければ `DEFAULT_MODEL_HEALTH`）。`getUsage(id)` は子会話の `UsageDoc` を読み、`UsageBucket`（`totalTokens` など）を返す。web は読まない。
- `code.result` の `ok:false`・`tool.result` のエラーで加算し、成功で 0 に戻す。`lastFailureAt` を更新する。
- 加算後に `MODEL_MISMATCH_THRESHOLD` に達したら、`model.mismatch` を sink に流し、当該 run の入れ子呼び出しを `beforeTool` で block する。次の `send` は `CodeModeError("model_mismatch")` を throw する。黙って direct に落とさない。
- モデルを切り替えたら（`modelByConversation` と現在の model が違う）health を `DEFAULT_MODEL_HEALTH` に戻す。事前の capability 判定はしない（0199 §2.2）。

### 3. send の検査

```ts
async send(id, text, requestId?) {
  const profile = await getProfile(id);
  if (profile.toolSurface === "code" && codemode === undefined) {
    throw new CodeModeError("profile_unavailable");
  }
  const needsBudget = profile.toolSurface === "code" || profile.subagents;
  const budget = needsBudget
    ? createRunBudget({ limits: profile.limits, conversationId: conversationId(id) })
    : undefined;
  if (budget !== undefined) activeBudgets.set(id, budget);
  try {
    // 既存の submit → wait
  } finally {
    if (budget !== undefined) {
      activeBudgets.delete(id);
      await commitBudget(budget);
    }
  }
}
```

- `maxTurns` は `changeFor` が設定する。direct / no subagents では null。
- `budget.snapshot()` は `RunBudget`。`UsageDoc` の読み取りは 0201。
- 0202 は `code-mode-hooks` 拡張（`beforeTool` の subcall 予算、`wrapTool` の event）を持ち、`toolSurface:"code"` または `subagents:true` のとき **必ず add** する。選択された拡張でないと hook が効かないため。
- `ToolTask` の `beforeTool` フックで `call.parent !== undefined` の入れ子だけ `budget.reserve("subcall")` し、上限なら `{ block: "subcall budget exceeded" }` を返す。モデル自身の tool 呼び出しは数えない。

### 4. event

- 0200/0201 のツールは sink を受け取らない。0202 が `wrapTool` / ツール結果 / `pi.live.nestedTools` / `ModelHealth` から `CodeModeEvent` を作り、`onCodeModeEvent` に流す。`model_mismatch` は `model.mismatch` として流す。
- sink は `options.onCodeModeEvent`。`session.ts` の送信経路とは別に、`AgentSession` の closure に保持し、**0202 が try/catch で握る**（0199 の policy）。
- 本文・引数・出力は出さない（0199）。

### 5. list

- `listConversations` は `scanConversations` の `owner` を見て、owner 付き（subagent の子）を一覧から外す。子は SubagentRow から開く。
- `getConversation` は子も返す（metadata は 0199/0201 が保証）。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `createConversation({profile:{toolSurface:"code",subagents:true,limits}})` → `getProfile` が同じ | 高 | 受入2-4 |
| C2 | `toolSurface:"code"` → `pi.agent.modelTools` が `[codemodeTool]`、`maxTurns` が 12 | 高 | 受入5 |
| C3 | `toolSurface:"direct", subagents:false` → code mode 拡張が外れ、`modelTools` が null | 高 | 受入6 |
| C4 | `direct, subagents:true` → subagent 拡張だけ有効 | 高 | 受入6 |
| C5 | codemode disabled で `toolSurface:"code"` → `profile_unavailable`、profile は変わらない | 高 | 受入7 |
| C5b | code.result / tool.result が `MODEL_MISMATCH_THRESHOLD` 回連続で失敗 → `model_mismatch`。成功で health が 0 に戻る | 高 | 受入13 |
| C6 | `send` で budget.snapshot が 1 回 commit される | 中 | 受入8 |
| C7 | 既存会話（profile 無し）→ DEFAULT_AGENT_PROFILE | 高 | 後方互換 |
| C8 | 子会話（owner 付き）→ `listConversations` に出ない。`getConversation` では開ける | 高 | 受入10 |
| C9 | `onCodeModeEvent` に `code.*` / `subagent.*` / `model.mismatch` が流れる | 中 | 受入11 |
| C10 | `close()` で注入 sandbox を 1 回だけ閉じる | 高 | 受入9 |
| C10b | 子会話（owner 付き）にも metadata entry がある | 高 | 受入10 |
| C10c | モデル変更で health が reset される | 中 | 受入13 |
| C10d | `maxSubCalls` 超過で入れ子呼び出しが block される | 高 | 受入11 |
| C10e | `npm run check` | 高 | 受入12 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1-C5 / C7 | 状態遷移 | unit（MemoryStorage） | `packages/agent/src/session.test.ts` |
| T2 | C6 / C9 | シナリオ | integration（MemoryStorage + faux） | `packages/agent/test/integration/session.test.ts` |
| T3 | C8 | 一覧 | unit | 同 |
| T4 | C10 / C10b | 状態遷移 | unit（MemoryStorage） | `packages/agent/src/session.test.ts` |
| T5 | C10c / C10d | シナリオ | integration（MemoryStorage + faux） | `packages/agent/test/integration/session.test.ts` |
| T6 | C10e | ゲート | static | `npm run check` |

## Notes

- 0049 が `session.ts` に `usage()` / `inspect()` を足す。本 issue はその後（または同時）に rebase する。
- `configure` の `extensions` は **名前**で保存されるが、引数は `Extension` オブジェクト。`defineExtension` の `name` を `codemode` / `subagent` に固定する。
- `modelTools` は `tools` の部分集合でなければならない。`toolSurface:"code"` の `tools` に `codemode` が含まれることを起動時に検査する。
- `session.ts` は Worker-safe。`CodemodeSandbox` / `node:*` を import しない。
- `ConversationMetadata.profile` は optional。既存 metadata に無い場合は `DEFAULT_AGENT_PROFILE` とみなす。`ensureMetadata` が全 conversation に entry を作るので、子の `metadataOf` が throw しない。
- `onCodeModeEvent` の保存は 0203。本 issue は sink に流すだけ。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | `extensions` の add/remove を 1 回でできるか | `{add, remove}` の両方を渡せる | 0202 | lead | C2/C3 |
| U-02 | `budget` を run ごとに作る方法 | `Map<ConversationId, RunBudgetController>` | 0202 | lead | C6 |
| U-03 | `code.*` をツール結果から作るか `wrapTool` か | `details.calls` から作る（本文なし） | 0202/0215 | lead | C9 |
| U-04 | direct + subagents を許すか | 許す（独立軸） | 0201/0202 | lead | C4 |

## やらないこと

- `server` の配線（0203）。
- sandbox Worker（0214）。
- WS / UI（0215）。
- 予算の USD 換算。
- 永続 REPL。

## Log

- 2026-11-17: 作成。2 値の mode をやめ、`AgentProfile`（toolSurface / subagents / limits）にした。

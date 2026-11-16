# 0201: subagent と実行予算（深さ・本数・usage）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0199
touches: packages/agent/src/code-mode/subagent.ts, packages/agent/src/code-mode/budget.ts, packages/agent/src/code-mode/subagent.test.ts, packages/agent/src/code-mode/budget.test.ts, work/issues/0201-subagent-budget.md

## Intent

code mode の「子に分割する」と「木で予算を閉じる」を実装する。
prime-agent / pi-durable の subagent は公式 API ではなく、`tx.createConversation({ownership:{kind:"task"}})` + `api.conversation()` + `submit().wait()` の合成である（pi-durable README の example 21）。
予算 API は pi-durable に無いので、hns 側で深さ・本数・時間・トークンを閉じる。

## Goal

`@hns/agent` に subagent ツールと予算コントローラを置く。

- 同期の `subagent({task})`。子は実会話で、結果は最終アシスタントテキスト。
- 深さは親の owner 連鎖から数える。モデルの引数を信用しない。
- 子の本数・同時数・木の時間・木のトークンを予算で閉じる。
- 子の usage は子の `pi.usage` から読み、親の結果に載せない（二重計上を避ける）。

## Acceptance criteria

- [ ] `createSubagentTool({ budget, limits, subagentExtension, codemodeExtension? })` が `subagent` ツールを返す。`budget` は `(conversationId) => RunBudgetController`、`subagentExtension` は `() => Extension`。引数は `{ task: string }` のみ
- [ ] 子は `api.commit(tx => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }))` で作る。replay 時は `tx.scanConversations({ ownerTaskId })` で既存を再利用する
- [ ] 子の `ConversationMetadata` を `writeMetadata` で書く（title は `Subagent`、projectId は親、profile は `{toolSurface:"direct", subagents:false, limits: 親}`）。`ensureMetadata`（0202）が先に入れた entry を上書きする。`ConversationIndexDoc` / `writeMetadata` は `../conversation-metadata.ts` から import する
- [ ] 子は親の agent を継承し、`configure(tx, child, { extensions: { remove: [subagentExtension(), ...(codemodeExtension ? [codemodeExtension] : [])] }, modelTools: null, maxTurns })` で **direct / no subagents** にする（code mode の子はコード実行しない）
- [ ] 深さ = owner 連鎖の長さ。`depth >= maxDepth` なら `depth_exceeded` を値で返す（throw しない）
- [ ] 子の本数 `maxChildren`、同時 `maxConcurrentChildren` を超えたら `children_exceeded` を値で返す。同時数は子の settle/abort で戻す
- [ ] `api.details({ conversationId: child, name: "Subagent", startedAt: now })` を呼び、UI が子へ遷移できる。`ms` は `startedAt` から、`tokens` は子の `UsageDoc` から UI が読む
- [ ] 結果は `options.answerText ?? defaultAnswerText` で `AssistantEntry` から text を読む。`settled.status !== "done"` は `isError`
- [ ] 親の abort で子も止まる（pi-durable の ownership 連鎖に任せる。追加の abort 呼び出しをしない）
- [ ] `createRunBudget({ conversationId, limits })` が `RunBudgetController` を返す。`runId` / `startedAt` は factory が生成する。`reserve(kind)` / `release(kind)` / `checkUsage(usedTokens)` / `snapshot()` を持つ
- [ ] `maxTreeTokens` は `api.snapshot(UsageDoc, conversationId, context)` の差分で判定する。子の usage は `api.snapshot(UsageDoc, childId, context)` で読む
- [ ] 予算超過は `budget.exceeded` イベント（`scope` 付き）と `CodeModeFailureCode` の両方で返す
- [ ] `npm run check` が通る

## 設計

### 1. subagent ツール

```ts
export interface SubagentOptions {
  readonly budget: (conversationId: ConversationId) => RunBudgetController;
  readonly limits: CodeModeLimits;
  readonly subagentExtension: () => Extension; // 子で remove する拡張（実行時に解決）
  readonly codemodeExtension?: Extension; // 子で remove する code mode 拡張（無い場合もある）
  /** 子の AssistantEntry から text を読む。省略時は既定実装（tx.entry）を使う。 */
  readonly answerText?: ((api: ToolExecutionApi, id: EntryId, context: Context) => Promise<string>) | undefined;
}

export function createSubagentTool(options: SubagentOptions): ToolRegistration<typeof schema>;
// 実装内で options.answerText ?? defaultAnswerText を使う。defaultAnswerText は
// api.commit(tx => tx.entry(AssistantEntry, id)) から text part を連結する。
```

実装の骨子:

```ts
const depth = await api.commit(async (tx) => {
  let n = 0;
  let current = await tx.conversation(api.conversationId);
  while (current?.owner !== undefined && n < 8) {
    n += 1;
    current = await tx.conversation(current.owner.conversationId);
  }
  return n;
}, context);
if (depth >= options.limits.maxDepth) return refusal("depth_exceeded");

const budget = options.budget(api.conversationId);
const reserved = budget.reserve("child");
if (!reserved.ok) return refusal(reserved.code);

const child = await api.commit(async (tx) => {
  const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
  if (existing !== undefined) return existing.id;
  const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
  await configure(tx, created.id, {
    extensions: { remove: [options.subagentExtension(), ...(options.codemodeExtension !== undefined ? [options.codemodeExtension] : [])] },
    modelTools: null,
    maxTurns: options.limits.maxTurns,
  });
  return created.id;
}, context);

await api.details({ conversationId: child, name: "Subagent", startedAt: nowIso() }, context);
const handle = await api.conversation(child, context);
if (handle === undefined) return refusal("children_exceeded", "child conversation missing");
const submission = await handle.submit(
  { type: "input", content: args.task, requestId: "subagent:" + api.taskId }, context);
const settled = await submission.wait(context);
const text = settled.status === "done" && settled.type === "input"
  ? await (options.answerText ?? defaultAnswerText)(api, settled.answer, context)
  : "";
budget.release("child");
return settled.status === "done"
  ? { output: [{ type: "text", text }], details: { conversationId: child, name: "Subagent", startedAt } }
  : { output: [{ type: "text", text: "subagent failed: " + settled.status }], isError: true, details: { conversationId: child, name: "Subagent", startedAt } };
```

- `replay: "safe"`。`requestId` は `subagent:<taskId>` で固定し、再送で二重に送らない。
- 子の最終テキストは `tx.entry(AssistantEntry, settled.answer)`。`ConversationHandle` に `entries` は無い（1.5.0）。
- 子の usage は **結果に載せない**。`pi.usage.tools` への二重計上を避ける。木の集計は budget が子の `UsageDoc` を読む。
- 子の abort は親 abort の ownership 連鎖で伝播する。ツール内で `handle.abort()` を呼ばない（二重 abort を避ける）。
- 深さの上限は 8 でループを打ち切る（壊れた owner 連鎖で無限ループしない）。

### 2. 予算

```ts
export type BudgetKind = "child" | "subcall";

export type RunBudgetState = RunBudget;

export interface RunBudgetController {
  reserve(kind: BudgetKind): { ok: true } | { ok: false; code: CodeModeFailureCode; limit: number; used: number };
  release(kind: BudgetKind): void;
  checkUsage(usedTokens: number): { ok: true } | { ok: false; code: "budget_exceeded"; limit: number; used: number };
  snapshot(): RunBudgetState;
}
```

- `maxChildren` は「1 run で作る子の総数」、`maxConcurrentChildren` は「同時に走る子」。
- `maxSubCalls` は **`call.parent` 付きの入れ子ツールだけ**。subagent は `maxChildren` / `maxConcurrentChildren` で閉じ、二重計上しない。code mode の入れ子は 0202 が `beforeTool` で controller に渡す（本 issue は controller の API だけ）。
- `maxTreeTokens` は、親の `UsageDoc` と子の `UsageDoc` の合計。`null` は会話の日次予算に委ねる（`docs/limits.md`）。
- `maxWallMs` は `startedAt + maxWallMs`。超過は `budget.exceeded(scope:"wall")`。
- 予算 doc は conversation scope、`version: 1`、`fork: "initial"`、`checkpointWhen: () => false`。run の終わりに 1 回 commit する（毎 tool で commit しない）。
- クラッシュ時は in-memory の使用量が失われる。再開時は doc の最後の値から始め、不明分は「使った可能性がある」として保守的に加算しない（code mode は課金の正本ではない。gateway が金額の天井）。

### 3. 二重計上の規則

| 対象 | 計上先 | 親の結果に載せるか |
| --- | --- | --- |
| code mode の script 内 `tools.x` | `pi.usage.tools[x]` | 載せない |
| subagent の子会話 | 子の `pi.usage` | 載せない |
| code mode の `models.classify` | `pi.usage.tools["pi.codemode.models.classify"]` | 載せない |
| 親のモデル往復 | 親の `pi.usage.models` | — |

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 親 → `subagent` → 子が答えを返す。`details.conversationId` がある | 高 | 受入1-7 |
| C2 | 子で `subagent` を呼ぶ → `depth_exceeded`（maxDepth 1） | 高 | 受入4 |
| C3 | 5 本目の子 → `children_exceeded`。同時 3 本目 → 同 | 高 | 受入5 |
| C4 | 親 abort → 子も abort し、親が idle になる | 高 | 受入8 |
| C5 | 子 2 本の usage 合計 = 親の木の合計。親の結果に `usage` が無い | 高 | 受入9-10 |
| C6 | `maxWallMs` 超過 → `budget.exceeded(scope:"wall")` | 中 | 受入10 |
| C7 | 同じ `requestId` でツールが replay → 子が二重に作られない | 高 | 受入2 |
| C8 | `npm run check` | 高 | 受入11 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C7 | シナリオ | integration（MemoryStorage） | `subagent.test.ts` |
| T2 | C2 / C3 | 境界（1/2/4/5） | unit + integration | 同 |
| T3 | C4 | 異常系 | integration | 同 |
| T4 | C5 / C6 | 集計・境界 | unit | `budget.test.ts` |
| T5 | C8 | ゲート | static | `npm run check` |

## Notes

- 参照: pi-durable `README.md` `Abort and Subagents` / `Child Tasks` / `Usage and Cost`、`dist/harness/{types,tool,usage}.d.ts`、`.work/pi/packages/durable/test/examples/21-subagent-foreground.ts`。
- 深さはモデルの引数ではなく `ConversationRecord.owner` 連鎖で数える。`tx.conversation()` で親を辿る。
- subagent の有効性はモデル依存（指示追従・要約・過剰呼び出し）。0199 の `ModelHealth` と 0216 の評価で扱い、本 issue は機構だけ。
- `configure(tx, child, ...)` は子の作成と同じ commit で呼ぶ（公式例）。`extensions.remove` は Extension オブジェクトを渡す。
- 同じ commit で `writeMetadata(tx, child, { ...parentMeta, title: "Subagent", profile: { toolSurface: "direct", subagents: false, limits: parentMeta.profile?.limits ?? DEFAULT_CODE_MODE_LIMITS } })` を呼ぶ。親の entry は `tx.doc(ConversationIndexDoc).items[String(api.conversationId)]` で読む。
- 子の `extensions` は `{ remove: [options.subagentExtension(), ...(codemodeExtension ? [codemodeExtension] : [])] }`、`modelTools: null`。code mode の子は **direct / no subagents**（通常ツールのみ）で、コード実行・再帰・子予算を持たない。
  子の profile は `toolSurface: "direct", subagents: false`。projectId と limits は親から写す。将来、子も code にするなら、この制限を外す。
- `maxTreeTokens` の読み取りは `UsageDoc`。`api.snapshot(UsageDoc, conversationId, context)` は `ToolExecutionApi` の `DocumentReader` で読める（context を忘れない）。
- `budget.exceeded` は `CodeModeEvent`（`CodeModeEventSink`）と `CodeModeFailureCode` の両方。イベントは sink、返り値はモデル向け。既存 `AgentEvent` は触らない。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | `tx.createConversation` が tool の commit 内で許されるか | 許される（公式例の `api.commit`） | 0201/0202 | lead | K2 スパイク |
| U-06 | 子を direct にするか code にするか | direct（通常ツールのみ） | 0201/0202 | lead | K2 |
| U-05 | budget を run ごとに解決する方法 | `(conversationId) => RunBudgetController` | 0202 | lead | 0202 |
| U-02 | 子の usage を親の `UsageDoc` に写すか | 写さない（木は読み取り時に合算） | 0201/0215 | lead | 0201 |
| U-03 | `maxSubCalls` の数え方 | `call.parent` 付きの入れ子のみ（subagent は含めない） | 0202 | lead | 2026-11-17 |
| U-04 | 予算 doc の更新頻度 | run 終了時に 1 回 | 0201 | lead | 0201 |

## やらないこと

- `session.ts` の合成（0202）。
- code mode の実装（0200）。
- 子の非同期・background 実行（将来）。
- 木の USD 換算（gateway）。
- 子の UI 表示（0215）。

## Log

- 2026-11-17: 作成。0199 の契約に従い、subagent と予算を 1 issue にまとめる（同じ `CodeModeLimits` を共有するため）。

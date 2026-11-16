# 0199: code mode の実行契約（profile・event・budget・モジュール境界）

status: open
priority: next
design: agreed
design-ref: D098
depends-on: -
touches: packages/core/src/types.ts, packages/core/src/agent-profile.ts, packages/core/src/agent-profile.test.ts, packages/core/src/index.ts, packages/agent/src/code-mode/contract.ts, packages/agent/src/conversation-metadata.ts, packages/agent/src/session.ts, packages/agent/src/code-mode/events.ts, packages/agent/src/code-mode/contract.test.ts, packages/agent/src/conversation-metadata.test.ts, packages/agent/src/code-mode/events.test.ts, docs/code-mode.md, work/issues/0199-code-mode-contract.md

## Intent

code mode（モデルにはコード実行 1 ツール、ツールはコード内の関数、子は同期、予算は木で閉じる）を、
実装ごとに型・イベント・上限がぶれない形で始める。
進行管理のための段階名（番号や略号）は使わない。段階名は概念として腐敗し、実装の名前を縛るため。
本 issue は **code mode の実行契約だけ** を固定し、実装（0200〜0203, 0214〜0216）が互いの型を修正しなくて済むようにする。

## Goal

code mode の実行時契約を 1 箇所に固定する。

- 会話の **agent profile**（ツール表面・subagent の有無・予算）と、その保存・読み出し・切替の型。
- code mode のイベント語彙と、既存 `EVENT_NAMES` への対応。
- 実行ツリーの予算（`CodeModeLimits` / `RunBudget`）の型と既定値。
- codemode / subagent / budget のモジュール境界と、各実装 issue が触るパス。
- 失敗コード（`profile_unavailable` など）の閉じた語彙。

振る舞いの実装は 0200〜0216。本 issue は型・doc・純粋関数・テストまで。

## Acceptance criteria

- [ ] `AgentProfile` / `CodeModeLimits` を **`@hns/core`**（`packages/core/src/agent-profile.ts`）に定義し、`core/src/index.ts` から `export * from "./agent-profile.ts";` する。`toolSurface: "direct" | "code"`、`subagents: boolean`、`limits` の直交した設定にし、**2 値の mode にはしない**
- [ ] `DEFAULT_AGENT_PROFILE` は `{ toolSurface: "direct", subagents: false, limits: DEFAULT_CODE_MODE_LIMITS }`
- [ ] `CodeModeLimits` の型・既定値・検証を core に置く。`RunBudget` の型は agent に置き、実装・永続化は 0201、送信時の検査は 0202
- [ ] `CodeModeEvent` / `CodeModeEventSink` を `code-mode/events.ts` に置く。既存の `AgentEvent`（direct tools / ツール観測）は変えない。本文・引数・出力は入れない
- [ ] core の `EVENT_NAMES` に `code.call` / `code.result` / `subagent.spawn` / `subagent.settle` / `budget.exceeded` / `model.mismatch` を足す
- [ ] `CodeModeEvent` → `EventName` の対応を 1 関数に閉じる（`toCoreEventName`）。未知は `never` で落ちる
- [ ] `CodeModeFailureCode` を閉じた union にする（`profile_unavailable` / `model_mismatch` / `budget_exceeded` / `depth_exceeded` / `children_exceeded` / `sandbox_unavailable`）
- [ ] `ConversationMetadata` / `ConversationIndexDoc` / `ensureMetadata` / `writeMetadata` を `conversation-metadata.ts` に **移動**する。`session.ts` の旧定義の削除と import への切替は 0199 で行う（0202 は import のみ）。ensure/write を提供する。**全 conversation（subagent の子を含む）への保証は 0202 の `conversationCreated`**
- [ ] `docs/code-mode.md` に、profile・ツール表面・イベント・予算・安全・非目標を書く
- [ ] `npm run check` が通る

## 設計

### 1. agent profile: 2 値の mode ではなく、直交した設定（core の型）

**2 値の `agentMode` は採用しない。** 外部製品の概念でもなく、code mode を opt-in するために
hns 側で作った便宜的な 2 値である。開発用途では「code 実行は使うが subagent は使わない」「direct だが subagent は使う」
「予算だけ上げる」といった組合せがあり、2 値では表せない。

pi-durable 1.5.0 の `configure` が持つのは `extensions` / `tools` / `modelTools` / `maxTurns` で、
「mode」フィールドは無い。hns はその 4 つを **AgentProfile** に射影する。

```ts
export const TOOL_SURFACES = ["direct", "code"] as const;
export type ToolSurface = (typeof TOOL_SURFACES)[number];

export type CodeModeLimits = {
  /** 子 RLM の深さ。0 = 子なし。code mode の既定は 1。 */
  readonly maxDepth: number;
  /** 1 実行で作れる子会話の数。 */
  readonly maxChildren: number;
  /** 同時に走らせる子会話の数。 */
  readonly maxConcurrentChildren: number;
  /** code mode から呼ぶ入れ子ツールの総数（`call.parent` 付きのみ。subagent は含めない）。 */
  readonly maxSubCalls: number;
  /** 実行ツリーのトークン上限。null は会話の日次予算に委ねる。 */
  readonly maxTreeTokens: number | null;
  /** 実行ツリーの wall-clock 上限。 */
  readonly maxWallMs: number;
  /** 1 run のモデル往復の上限。 */
  readonly maxTurns: number;
}

export const DEFAULT_CODE_MODE_LIMITS: CodeModeLimits = {
  maxDepth: 1,
  maxChildren: 4,
  maxConcurrentChildren: 2,
  maxSubCalls: 16,
  maxTreeTokens: null,
  maxWallMs: 10 * 60 * 1000,
  maxTurns: 12,
};

export type AgentProfile = {
  /** direct = 今のツールをモデルに並べる。code = codemode 1 個に絞る。 */
  readonly toolSurface: ToolSurface;
  /** subagent ツールを有効にするか。toolSurface とは独立。 */
  readonly subagents: boolean;
  /** code mode / subagent の実行予算。 */
  readonly limits: CodeModeLimits;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  toolSurface: "direct",
  subagents: false,
  limits: DEFAULT_CODE_MODE_LIMITS,
};

```

- `toolSurface: "code"` は「モデルに `codemode` だけを見せる」。script からは callable な全ツールを呼べる。
- `subagents: true` は「モデルに `subagent` ツールを足す」。`toolSurface` が `direct` でも `code` でもよい。
- `limits` は code / subagent の両方に効く。`direct` + `subagents: false` では実質未使用。
- UI の「Direct / Code / Delegate」などのプリセットは **UI の表現** で、保存するのは `AgentProfile`。
- `AgentProfile` / `CodeModeLimits` は **`@hns/core`** に置く。理由: WS の snapshot / GraphQL / web が `@hns/agent` に依存できない（core は誰にも依存しない）。`@hns/agent` は core から import して re-export する。
- `packages/core/src/agent-profile.ts` は valibot だけを import する。`AgentProfile` / `CodeModeLimits` は `type` alias（index signature を持たない）。`ConversationMetadata` は agent 側で `JsonObject`（`@earendil-works/pi-durable`）を extends し、`profile?: AgentProfile` を持つ。
- 既存会話は `DEFAULT_AGENT_PROFILE`（direct / no subagents）。

**なぜ 2 値ではないか**: 2 値は「code mode を使うか」と「subagent を使うか」を混ぜる。
モデルの能力・コスト・危険度は別々に変わるので、別の軸にする。プリセットは後から増やせるが、データは増やさない。
```ts
export const CodeModeLimitsSchema: v.GenericSchema<unknown, CodeModeLimits> = v.strictObject({
  maxDepth: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxChildren: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxConcurrentChildren: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxSubCalls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxTreeTokens: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxWallMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxTurns: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const AgentProfileSchema: v.GenericSchema<unknown, AgentProfile> = v.strictObject({
  toolSurface: v.picklist(TOOL_SURFACES),
  subagents: v.boolean(),
  limits: CodeModeLimitsSchema,
});

/** Parse an untrusted profile; unknown keys are rejected. */
export function parseAgentProfile(value: unknown): AgentProfile {
  return v.parse(AgentProfileSchema, value);
}
```

### 1.1 RunBudget（agent の型）

`RunBudget` は pi-durable の numeric `ConversationId` を持つため **core には置かない**。agent の `code-mode/contract.ts` に置く。

```ts
export type RunBudget = {
  readonly runId: string;
  readonly conversationId: ConversationId; // pi-durable の numeric brand
  readonly children: number;
  readonly subCalls: number;
  readonly activeChildren: number;
  readonly tokens: number;
  readonly startedAt: string;
};
```

`maxTreeTokens: null` は「会話の日次予算（`docs/limits.md`）を超えない範囲で使う」の意味。
`RunBudget.conversationId` と `ensureMetadata` の `id` は pi-durable の numeric `ConversationId`。doc の key は `String(id)` を使う（core の string brand と混ぜない）。
`RunBudget` の実装・永続化は 0201 の `code-mode/budget.ts`。0199 は型だけを持ち、`limits` は profile から読む（RunBudget に複製しない）。
gateway の USD 予算（`packages/server/src/gateway/budget.ts`）とは別物で、混ぜない。

### 2. profile は ConversationMetadata の内部 field

`Conversation`（core）は変えない。profile は `ConversationMetadata`（[session.ts](../../packages/agent/src/session.ts) の session-scoped index）に置く。
D1 の会話行を増やさず、既存の metadata と同じ commit で書ける。**profile の書き込みは 0202**。

```ts
export interface ConversationMetadata extends JsonObject { // JsonObject は @earendil-works/pi-durable の型
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isArchived: boolean;
  readonly deletedAt: string | null;
  readonly profile?: AgentProfile; // 既存 entry は欠落 = DEFAULT_AGENT_PROFILE（JSON doc なので明示 undefined は持たない）
}

export interface ConversationIndex extends JsonObject {
  readonly items: Record<string, ConversationMetadata>;
}

export const ConversationIndexDoc = defineDoc<ConversationIndex>({
  kind: "hns.conversation.index", // 既存 kind を維持
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: () => false,
});

export async function ensureMetadata(tx: Tx, id: ConversationId, fallback: ConversationMetadata): Promise<void>;
export async function writeMetadata(tx: Tx, id: ConversationId, metadata: ConversationMetadata): Promise<void>;
```

- 新規会話は `DEFAULT_AGENT_PROFILE`。`createConversation({ profile })` は 0202 で受ける。
- 保存された profile が不正なら `ValiError` で落とす。既定に丸めない（AGENTS.md）。
- 既存 entry に `profile` が無い場合は `DEFAULT_AGENT_PROFILE` とみなす（後方互換）。
- 子会話は `tx.createConversation` で作られ init を通らないため、0202 の `conversationCreated` が `ensureMetadata` を呼び、
  0201 が子の entry を親から書く（title は `"Subagent"`、projectId は親、profile は direct / no subagents）。

### 2.1 Conversation metadata

`ConversationIndexDoc` は `conversation-metadata.ts` へ移設し、`session.ts` の旧定義の削除と import への切替も 0199 で行う（0202 は import のみ）。
`ConversationIndexDoc` の `kind` / `version` は変えない。`ensureMetadata` は entry が無いときだけ書き、`writeMetadata` は上書きする。
これで subagent の子の `metadataOf` が throw しない。

### 2.2 モデル差は実行時に扱う（静的な capability 表は作らない）

code mode と subagent が有効に使えるかはモデルに強く依存する。RLM 論文でも、コーディング能力の低いモデルは RLM として機能せず、
モデルごとにプロンプト調整が必要とされている。Prime の追試でも、同じハーネスでモデルによって結果が変わる。
**この認識は正しい。ただし、静的な「モデル capability 表」で事前に許可/拒否する設計は採らない。**

理由:

- 既製品は、objective なモデル metadata（context window・入力 modality・function calling の有無）と、ユーザーのモデル選択、
  実測・警告・fallback で扱う。Claude Code は model alias / effort / automatic fallback、OpenHands は LLM profile と
  「powerful model が必要」という警告、Aider は model settings と弱いモデルの分離、LiteLLM は `supports_function_calling` のような
  API 能力の述語を持つ。**code mode の可否を 4 段階で静的に決める製品は見当たらない。**
- 静的な表は、新しいモデル・版・プロバイダの追加ごとに腐る。段階名をやめた理由と同じ種類の負債になる。
- モデルの有効性はタスク・プロンプト・文脈長・ツール数で連続的に変わる。`supported` / `unsupported` の二値・四値に押し込めると嘘になる。
- 事前に拒否すると、未評価の新しいモデルを試せない。逆に dev 上書きを許すと、ゲートの意味が薄れる。

代わりに、次の 3 層で扱う。

1. **objective な facts**: pi-ai の `Model`（`contextWindow` / `maxTokens` / `input` / `reasoning`）を使い、
   UI の警告と予算の参考にする。能力の可否は断定しない。function calling 非対応など API 能力は、provider のエラー/メタデータで扱う。
2. **実測の推奨**: 0216 がモデルごとに direct / code / code+subagents を比較し、`work/research/code-mode-eval.md` に
   「このモデルでは code が有効/限定的」と理由付きで書く。製品の設定を自動で書き換えない。UI は必要なら注記として表示する。
3. **実行時の健康状態**: 連続するコード失敗・ツールエラーを数え、閾値で `model_mismatch` を返して run を止める。
   黙って direct に落とさず、「direct に切り替えるか」を利用者に委ねる。

```ts
export interface ModelHealth {
  /** 直近の連続した code mode の失敗（構文エラー・未対応構文・出力不正）。 */
  readonly consecutiveCodeFailures: number;
  /** 直近の連続したツール呼び出しエラー。 */
  readonly consecutiveToolErrors: number;
  /** 最後に失敗した時刻（ISO 8601）。 */
  readonly lastFailureAt: string | null;
}

export const DEFAULT_MODEL_HEALTH: ModelHealth = {
  consecutiveCodeFailures: 0,
  consecutiveToolErrors: 0,
  lastFailureAt: null,
};

/** 3 回連続で失敗したら model_mismatch。成功で 0 に戻す。 */
export const MODEL_MISMATCH_THRESHOLD = 3;
```

- 0202 だけが `ModelHealth` を所有・更新し、閾値で `model_mismatch` を返す。0201 は子の結果を返すだけで health を持たない。
- 0216 の評価は「推奨」を作るだけで、製品の profile を自動変更しない。
- モデルを切り替えたら health はリセットする。

### 3. event

既存の `AgentEvent`（[events.ts](../../packages/agent/src/events.ts)）は direct tools / ツール観測で、0221（capability）が触る。
code mode は **別の `CodeModeEvent`** を `code-mode/events.ts` に置き、`onCodeModeEvent` で流す。既存の `AgentEvent` を広げない（並列のため）。
`Event`（core）は「D1 に残す監査」。1:1 ではないので、対応を `toCoreEventName` に集約する。

```ts
export type CodeModeEvent =
  | { readonly event: "code.call"; readonly at: string; readonly callId: string; readonly bytes: number; readonly hash: string }
  | { readonly event: "code.result"; readonly at: string; readonly callId: string; readonly ok: boolean; readonly ms: number; readonly outputBytes: number; readonly nestedCalls: number }
  | { readonly event: "subagent.spawn"; readonly at: string; readonly callId: string; readonly childConversationId: string; readonly depth: number }
  | { readonly event: "subagent.settle"; readonly at: string; readonly childConversationId: string; readonly status: "done" | "failed" | "aborted"; readonly ms: number }
  | { readonly event: "budget.exceeded"; readonly at: string; readonly scope: "depth" | "children" | "subcalls" | "tokens" | "wall"; readonly limit: number; readonly used: number }
  | { readonly event: "model.mismatch"; readonly at: string; readonly scope: "code" | "tool"; readonly failures: number };

export type CodeModeEventSink = (event: CodeModeEvent) => void;
```

- `CodeModeEventSink` は同期。sink が throw しても run を止めない（呼び出し側が握りつぶしてログに残す）。本文・引数・出力を入れない。

- `code.call` はコード本文を入れない。`bytes`（UTF-8 バイト数）と `hash`（SHA-256 hex）だけ。本文は transcript の tool 引数にある。
- `code.result` は出力本文を入れない。`outputBytes` と入れ子数だけ。
- `subagent.*` は子会話 ID（`ConversationId`）を入れる。UI が子へ遷移できる。
- `budget.exceeded` は「止めた理由」だけ。金額・プロンプトは入れない。

core `EVENT_NAMES` への追加:

```ts
"code.call",
"code.result",
"subagent.spawn",
"subagent.settle",
"budget.exceeded",
"model.mismatch",
```

`chat.budget_exceeded` は既存の会話予算用。code mode の木予算は `budget.exceeded` に分ける。

### 4. モジュール境界と所有

| パス | 所有 issue | 内容 |
| --- | --- | --- |
| `packages/core/src/agent-profile.ts` | **0199** | `AgentProfile` / `CodeModeLimits`（wire でも使う語彙） |
| `packages/core/src/index.ts` | **0199** | `agent-profile.ts` の re-export（public surface） |
| `packages/agent/src/code-mode/contract.ts` | **0199** | failure code・`toCoreEventName`・`ModelHealth`・`RunBudget`（numeric ConversationId）・agent 側の re-export |
| `packages/agent/src/conversation-metadata.ts` | **0199** | `ConversationMetadata` / `ConversationIndexDoc` / `ensureMetadata` / `writeMetadata`（`session.ts` から移設） |
| `packages/agent/src/code-mode/events.ts` | **0199** | `CodeModeEvent` / `CodeModeEventSink` |
| `packages/core/src/types.ts` | **0199** | `EVENT_NAMES` の追加のみ |
| `packages/agent/src/code-mode/codemode.ts` | **0200** | sandbox access、`codemode` 拡張、structured outputs |
| `packages/agent/src/code-mode/codemode-node.ts` | **0200** | Node の `CodemodeSandbox` |
| `packages/agent/src/code-mode/tools.ts` | **0200** | `read_file` / `write_file` の structured outputs |
| `packages/agent/src/code-mode/subagent.ts` | **0201** | 子会話、深さ、収集 |
| `packages/agent/src/code-mode/budget.ts` | **0201** | 予算の消費・判定・子 usage の合算 |
| `packages/agent/src/session.ts` | **0202** | `openSession` の合成、`setProfile`、`send` の検査 |
| `packages/server/src/do/{session,state,session-rpc}.ts` | **0203** | Session DO の配線、RPC |
| `tools/deploy/sandbox/**` | **0214** | 別 Worker / DO / wasm |
| `packages/core/src/stream.ts`, `packages/server/src/ws.ts`, `packages/web/**` | **0215** | frame・UI |
| `work/eval/code-mode/**` | **0216** | 評価 |

**禁止**: 0200/0201 が `session.ts` を触ること。0202 が 1 回で合成する。
**禁止**: 0202 が `core/src/types.ts` を触ること（0199 が追加済みの語彙を使うだけ）。
**禁止**: 0215 が `code-mode/events.ts` を触ること（frame は `stream.ts` に閉じる）。

### 5. 共有ファイルの所有者

code mode と capability（0220〜0229）は一部のファイルが重なる。**実装レーンを開くときに、先に統合する側を決める**。
以下の表をそのまま LANES に写す。

| ファイル | code mode の所有者 | 競合 | 決め |
| --- | --- | --- | --- |
| `packages/agent/src/session.ts` | 0199（移設）→ 0202 | 0149 / 0221 / 0226 | 0199 → 0149 → 0202 → capability。0199 は移設だけ、0202 が合成 |
| `packages/server/src/do/{session,state,session-rpc}.ts` | 0203 | 0049 / 0222 / 0224 / 0226 | 0049 → 0203 → capability。0203 を先に統合する |
| `tools/deploy/cloudflare.config.ts` | 0214 | 0224 | 0214 を先に統合する |
| `packages/web/src/app/Shell.tsx` | 0215 | 0103 / 0229 | 0103 → 0215 → 0229。0105 の後 |
| `packages/core/src/stream.ts` | 0105 | 0215 | 0105 → 0215 |
| `packages/web/src/live/state.ts` | 0203（pass-through）→ 0215 | 0105 | 0203 → 0215。本描画は 0215 |
| `packages/server/src/ws.ts` | 0105 | 0165 / 0215 | 0105 → 0165 → 0215 |
| `packages/agent/src/{agent,tools,events}.ts` | 0221 | code mode | **code mode は触らない**。`code-mode/tools.ts` / `code-mode/events.ts` / `code-mode/codemode-node.ts` に閉じる |
| `packages/core/src/types.ts` | 0199 | 0116 / 0117 / 0127 / 0129 / 0192 / 0197 | 0199 を先に統合する。他は rebase |
| `work/BOARD.md` / `work/LANES.md` | lead | — | この issue 群の追加は lead が行う |

### 6. 失敗コード

```ts
export const CODE_MODE_FAILURE_CODES = [
  "profile_unavailable",
  "model_mismatch",
  "budget_exceeded",
  "depth_exceeded",
  "children_exceeded",
  "sandbox_unavailable",
] as const;
export type CodeModeFailureCode = (typeof CODE_MODE_FAILURE_CODES)[number];

/** Expected code mode refusal. Callers branch on `code`; the message is for logs. */
export class CodeModeError extends Error {
  readonly code: CodeModeFailureCode;
  constructor(code: CodeModeFailureCode, message?: string) {
    super(message ?? code);
    this.name = "CodeModeError";
    this.code = code;
  }
}
```

- `profile_unavailable`: プロファイル選択時に sandbox / subagent 拡張が無い。黙って direct に落とさない。
- `model_mismatch`: 実行中にコード生成・ツール呼び出しの失敗が連続した。静的判定ではなく、実行時の健康状態で止める。
- `budget_exceeded`: 木の予算を超えた。`budget.exceeded` と対で返す。
- `depth_exceeded` / `children_exceeded`: 子の制限。
- `sandbox_unavailable`: 選択後、sandbox の起動・実行が失敗した。profile 選択時の不在は `profile_unavailable`。

| `budget.exceeded.scope` | 返す `CodeModeFailureCode` |
| --- | --- |
| `depth` | `depth_exceeded` |
| `children` | `children_exceeded` |
| `subcalls` / `tokens` / `wall` | `budget_exceeded` |

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `parseAgentProfile({ toolSurface:"code", subagents:false, limits: DEFAULT_CODE_MODE_LIMITS })` → その値 | 高 | 受入1 |
| C2 | `parseAgentProfile({ toolSurface:"auto", subagents:false, limits: DEFAULT_CODE_MODE_LIMITS })` → `ValiError`（既定に丸めない） | 高 | AGENTS.md |
| C3 | `DEFAULT_CODE_MODE_LIMITS` は通る。負値、`maxTurns`/`maxWallMs` の 0 は落ちる。`maxDepth`/`maxChildren`/`maxSubCalls` の 0 は許可 | 中 | 受入5 |
| C4 | 6 つの `CodeModeEvent` → `toCoreEventName` → `EVENT_NAMES` の対応。未知は型エラー | 中 | 受入4/5 |
| C5 | `CodeModeEvent` に本文・プロンプト・出力が入らない。既存 `AgentEvent` の型が変わらない | 高 | observability |
| C6 | `ensureMetadata` は既存 entry を上書きしない。`writeMetadata` は上書きする | 高 | 0201 |
| C7 | `npm run check` | 高 | 受入10 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C2 / C3 | 同値分割・境界 | unit | `packages/core/src/agent-profile.test.ts` / `packages/agent/src/code-mode/contract.test.ts`（contract.ts の全 export を 1 度 import し、knip の unused export を防ぐ） |
| T2 | C4 / C5 | 表 + 型 | unit | `packages/agent/src/code-mode/events.test.ts` |
| T3 | C6 | 状態遷移 | unit（MemoryStorage） | `packages/agent/src/conversation-metadata.test.ts` |
| T4 | C7 | ゲート | static | `npm run check` |

## Notes

- 2 値の `agentMode` は **採用しない**。pi-durable に mode は無く、`extensions` / `modelTools` / `maxTurns` の組合せを `AgentProfile` に写す。
- モデル依存の根拠: RLM 原論文は「コーディング能力の低いモデルは RLM として機能しない」「モデルごとにプロンプト調整が必要」とし、Prime の追試もモデル差を報告している。コンテキスト長や tool 呼び出しの安定性もモデルで変わる。
- プリセット（Chat / Code / Delegate など）は UI の表現。データは `AgentProfile` の直交した 3 軸。
- 既存の `AgentEvent` は 3 種だけ。code mode はこれを広げず、`code-mode/events.ts` に `CodeModeEvent` を置く。0221（capability）が `events.ts` を触るため、並列の境界を分ける。
- `EventName`（[types.ts](../../packages/core/src/types.ts)）は D1 の監査語彙。
- `ConversationMetadata.mode` は無い。`profile` が optional で、既存は default。
- `ConversationIndexDoc` の `kind` / `version` は既存のまま。移設だけで migration を増やさない。

## 未確定

| ID | 何が | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | profile の保存先 | **決定（user）**: `ConversationMetadata`（session index） | 0202/0215 | 2026-11-17 |
| U-02 | `maxTreeTokens: null` の意味 | **決定（user）**: 会話の日次予算に委ねる | 0201 | 2026-11-17 |
| U-03 | `subagent` を direct でも使うか | **決定（user）**: 使う（独立軸） | 0201/0202 | 2026-11-17 |
| U-04 | UI のプリセット名 | **決定（user）**: Direct / Code / Delegate | 0215 | 2026-11-17 |
| U-05 | profile 変更を履歴に残すか | **決定（user）**: `pi.agent` の `pi.system` に残る。専用 entry は作らない | 0215 | 2026-11-17 |

## やらないこと

- code mode / subagent / budget の実装（0200〜0202）。
- Session DO / GraphQL / WS / web の配線（0203〜0215）。
- D1 の `Conversation` 行・migration・GraphQL entity の変更。
- 永続 REPL / サブ LLM の直接呼び出し。
- 予算の USD 換算（gateway の担当）。

## Log

- 2026-11-17: 作成。段階名をやめ、`AgentProfile`（toolSurface / subagents / limits）で表す。
- 2026-11-17: D098 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

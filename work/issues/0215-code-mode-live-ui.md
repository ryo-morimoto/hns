# 0215: code mode のライブ表示（WS frame・プログラムカード・profile 切替）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0105, 0203
touches: packages/core/src/stream.ts, packages/server/src/ws.ts, packages/web/src/live/**, packages/web/src/screens/conversation/**, packages/web/src/app/Shell.tsx, packages/web/src/app/LiveConnection.tsx, packages/web/src/components/ProgramCard.tsx, packages/web/src/components/SubagentRow.tsx, work/issues/0215-code-mode-live-ui.md

## Intent

code mode の実行を利用者に見せる。コードセル・入れ子ツール・子エージェント・予算を、会話の流れを壊さずに
「プログラムカード」として出す。送信・transcript は 0105 が持つ。本 issue は code mode の表示と profile 切替だけ。

## Goal

- WS の snapshot / frame に `profile` / `programs` / `subagents` / `budget` を足す。
- pi-durable の `pi.live.nestedTools` と codemode の `details.calls` を、UI の `ProgramCard` に射影する。
- `setProfile` を WS の client message に足し、toolSurface / subagents を切り替える。
- 再接続の snapshot でカードが復元される。

## Acceptance criteria

- [ ] 0203 が `LIVE_PROTOCOL_VERSION` を `2` に上げ、`budget` / `mismatch` の型と snapshot フィールドを追加済み。0215 はそれを消費し、`code` / `subagent` だけを足す（二重定義しない）
- [ ] snapshot に `profile` / `programs[]` / `subagents[]` を足す。`budget` / `mismatch` は 0203 が protocol 2 で追加済みのフィールドを使う。既存 client は version 不一致で拒否される
- [ ] client message に `setProfile`（`{ conversationId, profile }`）を足す。server は Session RPC の `setProfile` を呼び、`accepted` / `rejected` を返す
- [ ] `ProgramCard` は `code`（モデルが書いたコード）、`output`（切詰め + 全文への参照）、`nestedCalls`（名前・状態・所要）、`tokens` を表示する。コードは transcript の tool 引数、結果は `details.calls` から作る
- [ ] `SubagentRow` は `name` / `status` を表示し、`ms` は details の `startedAt` から、`tokens` は 0203 が `getUsage` で充填した frame の値を表示する（web は `UsageDoc` を読まない）。`conversationId` があれば子へ遷移できる
- [ ] `budget` は残りトークン・時間を表示する。超過時は `budget.exceeded` を「止めた理由」として出す
- [ ] profile 切替は composer の 2 つのトグル（code 実行 / subagent）。`code` が `profile_unavailable` なら理由を出し、direct のまま
- [ ] 再接続: `resync` → snapshot → `programs` が復元される
- [ ] `applyLiveFrame` の switch は `never` 終端を維持する。未知 frame は protocol error
- [ ] `npm run check` が通る

## 設計

### 1. frame

```ts
type CodeFrame = {
  type: "code";
  callId: string;
  code: string;          // transcript の tool 引数（UI 表示用）
  state: "running" | "ok" | "error";
  output: string;        // 切詰め済み
  fullOutputPath?: string;
  nestedCalls: readonly { name: string; status: string; ms?: number }[];
};
type SubagentFrame = {
  type: "subagent";
  id: string;
  name: string;
  status: "running" | "done" | "failed" | "aborted";
  conversationId?: string;
  ms?: number;
  tokens?: number;
};
type BudgetFrame = { type: "budget"; remainingTokens: number | null; remainingMs: number | null; spentTokens: number };
type MismatchFrame = { type: "mismatch"; at: string; scope: "code" | "tool"; failures: number };
```

- 実行中は `pi.live.nestedTools` を `code` frame に射影する。終了後は codemode の `details.calls`（`CodemoToolDetails`）を使う。
- `code` の `code` は transcript の tool 引数から取る。`output` は `details` の bounded output。本文を event に複製しない。
- `subagent` は `pi.live.tools[].details.conversationId` と tool 結果から作る。`tokens` は 0203 の `subagent` frame が `getUsage` で埋める。
- `budget` は 0202 の `getBudget(id)`、`mismatch` は `getModelHealth(id)` を 0203 が frame に射影する。DO 再起動で health/budget は reset されるため、snapshot の `mismatch` は null になり得る（transcript のエラーで代替）。

### 2. snapshot

```ts
type LiveSnapshot = {
  // 既存...
  profile: AgentProfile;
  programs: readonly CodeFrame[];
  subagents: readonly SubagentFrame[];
  budget: BudgetFrame | null;
  mismatch: MismatchFrame | null;
};
```

- snapshot は常に authoritative。`resync` で作り直す。
- 実行中の `programs` は `pi.live` から、終了後は transcript / tool details から作る。二重表示を避けるため、`callId` で dedupe する。

### 3. UI

- `ProgramCard` は `components/ProgramCard.tsx`（新規）。コードは `<pre>`、出力は折りたたみ、`nestedCalls` は行、`tokens` は右肩。
- `ConversationView` は transcript の間に `ProgramCard` を挿入する（0105 の `Transcript` の拡張点を使う）。
- `Composer` に「code 実行」「subagent」の 2 つのトグル。モデルによる事前の無効化はしない。`model_mismatch` が返ったときに「モデルを変えるか direct に切り替えるか」を出す。送信は 0105 の既存 `send` をそのまま使う。
- 子は `SubagentRow` のリンクで子会話へ。子の画面は 0105 の会話画面を再利用する。

### 4. 0105 との境界

- 0105 は `stream.ts` / `ws.ts` / `screens/conversation` を touches に持つ。**0215 は 0105 の merge 後に rebase する**。
- 0105 の `Composer` / `Transcript` / `send` は変更しない。0215 は `ProgramCard` の挿入と `setProfile` の追加だけ。
- `LIVE_PROTOCOL_VERSION` の bump は 0215 が行う。0105 の client は version 1 を前提にしない（`stream.ts` の既存の拒否に従う）。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | snapshot（profile code+subagents, programs 2, subagents 1）→ state に復元 | 高 | 受入2/8 |
| C2 | `code` frame running → ok → `ProgramCard` が 1 枚のまま更新 | 高 | 受入4 |
| C3 | `subagent` frame → `SubagentRow` → 子へ遷移 | 中 | 受入5 |
| C4 | `setProfile(code+subagents)` → `accepted` → snapshot の profile が同じ | 高 | 受入3/7 |
| C5 | `setProfile(code)` で sandbox 無し → `rejected(profile_unavailable)`、UI は direct | 高 | 受入7 |
| C5b | `mismatch` frame → 「direct に切り替える」導線が出る。同じ DO への再接続 snapshot でも復元。DO 再起動後は null | 高 | 受入7 |
| C6 | 再接続 → `resync` → 同じ `programs` | 高 | 受入8 |
| C7 | 未知 frame → protocol error（クラッシュしない） | 中 | 受入9 |
| C8 | `npm run check` | 高 | 受入10 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C6 / C7 | reducer | unit | `packages/web/src/live/state.test.ts` |
| T2 | C2 / C3 | render | component | `packages/web/test/conversation/program-card.test.tsx` |
| T3 | C4 / C5 | シナリオ | integration（fake WS） | `packages/web/src/live/client.test.ts` |
| T4 | C8 | ゲート | static | `npm run check` |

## Notes

- 参照: 0105（会話画面）、0159（WS）、D077（WS のメッセージ）、pi-durable `live.d.ts` / `codemode.d.ts`。
- `programs` は `pi.live` と transcript の二重ソース。`callId` で dedupe し、snapshot では `pi.live` を優先する。
- コード本文は UI に出すが、event / log には複製しない（docs/observability.md）。
- `AgentProfile` / `CodeModeLimits` は `@hns/core`（`agent-profile.ts`）。web は `@hns/core` だけに依存し、`@hns/agent` を import しない。
- `setProfile` は 0203 の Session RPC を呼ぶ。WS の client message にして、GraphQL mutation（0198）を待たない。
- 0214 が blocked（cf wasm）でも、UI は `profile_unavailable` を表示できる。0215 は 0202/0203 だけで先に作れる（0214 は実行時依存）。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | 0105 の `Transcript` にカード挿入点があるか | `children` か `renderItem` を拡張 | 0215 | lead | 0105 merge |
| U-02 | `code` の output をどこから取るか | `details.calls` / `pi.live.tools[].output` | 0215 | lead | C2 |
| U-03 | `setProfile` を WS か GraphQL か | WS（0198 を待たない） | 0215 | lead | C4 |

## やらないこと

- 0105 の送信・transcript・下書き。
- 0198 の GraphQL mutation。
- 0214 の sandbox 配備。
- マシン側の Python カーネル。

## Log

- 2026-11-17: 作成。0105 の後に、code mode の表示だけを足す。

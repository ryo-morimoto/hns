# 0200: code mode（codemode・sandbox・structured output）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0199
touches: packages/agent/src/code-mode/codemode.ts, packages/agent/src/code-mode/codemode-node.ts, packages/agent/src/code-mode/tools.ts, packages/agent/src/code-mode/tools.test.ts, packages/agent/src/code-mode/codemode.test.ts, packages/agent/package.json, package-lock.json, work/issues/0200-code-mode.md

## Intent

code mode の「モデルにはコード実行 1 ツール、ツールはコード内の関数」を実装する。
pi-durable の `codemode` を fork せず compose し、sandbox は Node（テスト）と Cloudflare（後続）を差し替えられるようにする。
モデルに `read_file` / `write_file` / `bash` を直接並べず、`codemode` 1 個に寄せる。

## Goal

`@hns/agent` に code mode の feature を置く。

- `CodemodeAccess`（sandbox か disabled）と、`createCodeModeExtension`。
- Node 用の `createNodeCodemodeAccess`（テスト・CLI）。
- `read_file` / `write_file` の `structuredOutputSchema`（code mode の script が構造化結果を扱える）。
- code mode の入れ子呼び出しが `details.calls` と `pi.live.nestedTools` に出ることをテストで固定する。

## Acceptance criteria

- [ ] `CodemodeAccess` は `{kind:"sandbox", sandbox: CodemodeSandboxBase} | {kind:"disabled", reason: string}` の閉じた union。Worker-safe な module に置く
- [ ] `createCodeModeExtension(access)` は sandbox のとき `createCodemodeExtension({ sandbox, models: false, inlineBudget: 3000 })` を返し、disabled のとき `undefined` を返す（fail closed）
- [ ] Node の `createNodeCodemodeAccess()` は `CodemodeSandbox` を 1 個作り、`close()` を持つ。`./session` は `node:*` を import しない。`packages/agent/package.json` に `"./code-mode/node"` の subpath export を足し、0216 はそこから import する
- [ ] Cloudflare 用の `createRemoteCodemodeAccess(options)` を `code-mode/codemode.ts` に置く。`RemoteCodemodeSandbox`（`/portable`）を包み、server が pi-codemode を直接 import しなくて済む
- [ ] `code-mode/tools.ts` に `createCodeModeWorkspaceTools(workspace)` を置く。`ReadFileStructured = Extract<ReadReply, {ok:true}>` を型にし、`structuredOutputSchema` は **pi-schema の `obj({...})`（JSON Schema）** で定義する（valibot は JSON Schema ではない）。`content` は全文、モデル向け `output` は従来どおり 32K 文字で切る
- [ ] `write_file` の `structuredOutput` は `MutationResult`（`applied` / `conflict` / `unknown`）。`output` の JSON は変えない。既存の `tools.ts` は触らない（0221 が所有）
- [ ] code mode の script から `tools.read_file` を 2 回呼ぶテストで、`details.calls` が 2 件、`status: "ok"` になる
- [ ] 出力上限: script の `max_output_tokens` を超えた出力は切り詰められ、`fullOutputPath` が付く（`env` がある場合）。`env` が無い場合は切り詰めだけ
- [ ] disabled access では `codemode` ツールが 1 個も登録されない
- [ ] `npm run check` が通る

## 設計

### 1. 境界

```ts
// packages/agent/src/code-mode/codemode.ts — Worker-safe
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { RemoteCodemodeSandbox, type CodemodeRemote } from "@earendil-works/pi-codemode/portable";
export type { CodemodeRemote };

export type CodemodeAccess =
  | { readonly kind: "sandbox"; readonly sandbox: CodemodeSandboxBase }
  | { readonly kind: "disabled"; readonly reason: string };

export function createCodeModeExtension(access: CodemodeAccess): Extension | undefined {
  return access.kind === "sandbox"
    ? createCodemodeExtension({ sandbox: access.sandbox, models: false, inlineBudget: 3000 })
    : undefined;
}
```

Node の sandbox は `packages/agent/src/code-mode/codemode-node.ts` で作る（`node:*` を持つ唯一の入口）。`agent.ts` は触らない（0221 が所有）。

Cloudflare の remote は `@hns/agent` の Worker-safe factory で包む（server は pi-codemode を直接 import しない）:

```ts
export interface RemoteCodemodeOptions {
  readonly remote: () => CodemodeRemote;
  readonly interruptBudget?: number;
}

export function createRemoteCodemodeAccess(options: RemoteCodemodeOptions): CodemodeAccess {
  return {
    kind: "sandbox",
    sandbox: new RemoteCodemodeSandbox({
      remote: options.remote,
      interruptBudget: options.interruptBudget ?? 100_000,
    }),
  };
}
```

```ts
// packages/agent/src/code-mode/codemode-node.ts — Node only
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

export interface NodeCodemodeAccess {
  readonly access: CodemodeAccess;
  close(): Promise<void>;
}

export function createNodeCodemodeAccess(): NodeCodemodeAccess {
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
  return {
    access: { kind: "sandbox", sandbox },
    close: () => sandbox.close(),
  };
}
```

- `models: false`: `models.classify` / `generateImages` は code mode では使わない。ツール宣言とコストを減らす。
- `inlineBudget: 3000`: ツール宣言のトークン枠。ツールを増やすときはここを上げる（`max_output_tokens` とは別物）。
- `CodemodeSandbox` のコンストラクタに `tools` は渡さない。durable の code mode は会話の `callable` を script 開始時に渡す（`dist/codemode/codemode.js:223-272`）。

### 2. structured output（code mode 専用のツール）

既存の `tools.ts` は 0221（capability）が触るため、code mode は `code-mode/tools.ts` に **同じ名前のツール** を置く。
`createCodeModeWorkspaceTools(workspace)` は `read_file` / `write_file` を定義し、code のときだけ registry に install する。`structuredOutputSchema` は `import { obj, str, bool, num } from "@earendil-works/pi-schema"` を使う
（direct は既存の `workspaceTools` のまま）。読み取り上限・`failureOf`・`operationIdFor` は既存の実装を import して共有する。

`read_file` の `output`（モデル向け）は 32K 文字のまま。`structuredOutput` は script 向けに全文を返す。
`outputLimits` は `output` にだけ効くので、script は `structuredOutput` で全文を読める。

```ts
type ReadFileStructured = Extract<ReadReply, { ok: true }>;
// pi-durable の structuredOutputSchema は pi-schema (JSON Schema) を要求する。
structuredOutputSchema: obj({
  ok: bool(),
  content: str(),
  version: str(),
  truncated: bool(),
  characters: num(),
}),
// details の型は ReadFileStructured と一致することを単体テストで固定する。
```

- `write_file` は既存の `MutationResult` をそのまま `structuredOutput` にする。script は `status` で分岐できる。
- `read_file` の `truncated` は「モデル向け output を切ったか」ではなく「ファイルが 32K を超えたか」。`characters` は全文長。
- 失敗時は `structuredOutput` を付けない（`isError` の text に `ToolFailure` の JSON）。script は reject で受ける。

### 3. code mode のツール表面

- 0202 が `modelTools` を `[codemode]` に絞る。本 issue は `codemode` 拡張を作るだけ。
- script から見えるのは `agent.callable`（`callers` に `"tools"` を含む全ツール）。`bash` は `shell.kind === "sandboxed"` のときだけ registry に入る（既存の fail closed）。
- `subagent` は 0201 が別ツールとして足す。code mode の script から呼べる（`callers` 未指定）。
- `tool_search` / `deferred` は code mode では使わない（ツール数が少ない）。

### 4. sandbox の close

- Node の `createNodeCodemodeAccess()` はテストと将来の `openAgent` 用。code mode の製品経路（Session DO）は 0203 が `createRemoteCodemodeAccess` を使う。
- Cloudflare は `RemoteCodemodeSandbox` / `InlineCodemodeSandbox` を 0203/0214 が注入する。本 issue は `CodemodeAccess` の型だけ。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | sandbox access → `createCodeModeExtension` → `codemode` ツールが 1 個 | 高 | 受入2 |
| C2 | disabled access → `undefined` → registry に `codemode` が無い | 高 | fail closed |
| C3 | script が `tools.read_file` を 2 回呼ぶ → `details.calls` が 2 件、各 `ok` | 高 | 受入6 |
| C4 | 1MB のファイルを `read_file` → `structuredOutput.content` が全文、`output` は 32K で切れる | 高 | 受入4 |
| C5 | `write_file` の `conflict` → script が `status: "conflict"` を読める | 中 | 受入5 |
| C6 | `max_output_tokens` を超える `print` → 切詰め + `fullOutputPath`（`env` あり） | 中 | 受入7 |
| C7 | `./session` の import graph に `node:*` が無い | 高 | packages.md |
| C8 | `npm run check` | 高 | 受入8 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C2 | 同値分割 | unit | `packages/agent/src/code-mode/codemode.test.ts` |
| T2 | C3 / C5 | シナリオ | integration（MemoryStorage + CodemodeSandbox） | 同 |
| T3 | C4 | 境界（32K / 1MB） | unit | `packages/agent/src/code-mode/tools.test.ts` |
| T4 | C6 | 境界 | integration | `codemode.test.ts` |
| T5 | C7 | 静的 | lint / build | `npm run check` |

## Notes

- 参照: pi-durable `README.md` `Code Mode` / `Calling tools from tools`、`dist/codemode/codemode.{d.ts,js}`、pi-codemode `README.md` / `portable.d.ts`。
- `@earendil-works/pi-codemode` を直接 import するので、`packages/agent/package.json` に **1.5.0 固定**で宣言する。lock owner は本 issue。
- モデル依存（コード生成・ツール呼び出し・自己修復の差）は 0199 の `ModelHealth` と 0216 の評価で扱う。本 issue は機構だけ。
- `CodemodeSandbox` は Node の worker thread と QuickJS wasm をディスクから読む。テストは Node で動かす。
- Cloudflare の sandbox は 0203/0214。本 issue では `createInlineCodemodeSandbox` を import しない（Worker bundle を汚さない）。
- `read_file` の `structuredOutput` は全文を返すため、script が 1MB を変数に保持できる。`outputLimits` とは別。
- 既存 `tools.ts` の `MAX_READ_CONTENT` は export されていない。`code-mode/tools.ts` は同じ 32 * 1024 を持ち、理由をコメントに書く（二重定義を避けるため、0221 の後に統合を検討）。
- `operationIdFor(api.callId)` の 64 文字切り詰めは、nested の `write_file` で衝突し得る（code mode の既知リスク）。本 issue では `write_file` の structured output を足すだけにし、ID の修正は 0203 で必要なら扱う。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | `fullOutputPath` の置き場 | `env` の `createTempDir` / workspace の `.hns/tmp` | 0202/0203 | lead | 0202 |
| U-02 | `read_file` の全文 structured output を許すか | **決定（user）**: 許す（script の価値。outputLimits の対象外） | 0203 | lead | 2026-11-17 |
| U-03 | `write_file` の operationId 衝突 | 0203 で短い決定的 id に変える | 0203 | lead | 0203 |

## やらないこと

- `session.ts` の合成（0202）。
- subagent / budget（0201）。
- Cloudflare の sandbox 配備（0203/0214）。
- ツールの追加（MCP / web / search）。
- 永続 REPL。

## Log

- 2026-11-17: 作成。0199 の契約に従い、code mode の feature と structured output を分離する。

# 0214: sandbox Worker（RemoteCodemodeSandbox の配備）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0203
touches: tools/deploy/sandbox/**, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts, tools/deploy/modes.ts, tools/deploy/package.json, tools/deploy/package-lock.json, work/issues/0214-codemode-sandbox-deploy.md, work/research/code-mode-sandbox.md

## Intent

code mode を Cloudflare で安全に走らせる。`InlineCodemodeSandbox` は Session DO のスレッドを止めるので、
`RemoteCodemodeSandbox` を別 Worker の Durable Object として配備する（pi-codemode README の推奨）。
ただし `cf` が QuickJS の `.wasm` を `CompiledWasm` にできるかは未確認。最初にそこを確かめる。

## Goal

- `tools/deploy/sandbox/` に sandbox Worker（`CodemodeSandboxDurableObject`）を置く。
- 本体 Worker に `CODEMODE_SANDBOX` binding を足す。
- `cf deploy --dry-run` と実 dev 配備で、wasm が含まれ、DO が起動することを確認する。
- 10 秒計算の script が Session DO の他リクエストを止めないことを測る。

## Acceptance criteria

- [ ] `tools/deploy/sandbox/` に `package.json` / `cloudflare.config.ts` / `worker.ts` を置く。`worker.ts` は `CodemodeSandboxDurableObject` を継承した `class CodemodeSandbox` を定義し、`protected` の `maxMemoryLimitBytes` / `maxInterruptBudget` を設定して export する
- [ ] `cloudflare.config.ts` の `exports` に `CodemodeSandbox`（sqlite / DO）を足す。`workers_dev: false` / `preview_urls: false`
- [ ] `tools/deploy/cloudflare.config.ts` の本体 Worker に `CODEMODE_SANDBOX: bindings.durableObject({ worker: sandboxWorkerName, exportName: "CodemodeSandbox" })` を足す
- [ ] `cf deploy --dry-run` が sandbox Worker の wasm を含む bundle を作る。**wasm を扱えない場合はここで停止**し、結果を issue に記録する
- [ ] dev 環境で `RemoteCodemodeSandbox` から 1 script を実行できる。`CODEMODE_SANDBOX` が無い場合は `disabled`（0203）
- [ ] 10 秒計算の script 実行中に、Session DO の `getProfile` が 500ms 以内に返る（別 isolate の確認）
- [ ] `maxMemoryLimitBytes` / `maxInterruptBudget` を sandbox Worker の subclass で設定する（既定 32MiB / 100k）
- [ ] `npm run check` と `cf deploy --dry-run` が通る

## 設計

### 1. sandbox Worker

pi-codemode の README の最小形:

```ts
// tools/deploy/sandbox/worker.ts
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxMemoryLimitBytes = 32 * 1024 * 1024;
  protected override maxInterruptBudget = 100_000;
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
```

- `cloudflare.config.ts` の `exports` は本体と同じ `exports.durableObject({ storage: "sqlite" })` を使う。
- `main` は `worker.ts`。`compatibilityFlags` は `nodejs_compat` 不要（QuickJS は wasm）。
- `limits.cpu_ms` を設定する（例 60,000）。
- wasm は `@earendil-works/pi-codemode/cloudflare` が `quickjs-wasi/quickjs.wasm` を import する。`cf` の bundler が `CompiledWasm` にできるかを最初に確認する。

### 2. binding

```ts
// tools/deploy/cloudflare.config.ts
CODEMODE_SANDBOX: bindings.durableObject({
  worker: sandboxWorkerName(deployment.workerName),
  exportName: "CodemodeSandbox",
}),
```

- `sandboxWorkerName` は `modes.ts` に足す（例: 本体 worker 名 + "-sandbox"）。
- binding が無い環境では `SessionEnv.CODEMODE_SANDBOX` が undefined になり、0203 が `disabled` にする。
- `script_name` は `bindings.durableObject({worker})` が表現する。`RemoteCodemodeSandbox` 側に `scriptName` は無い。

### 3. 性能と制限

| 項目 | 値 | 確認 |
| --- | --- | --- |
| 10 秒計算が Session DO を止めない | 他リクエスト p95 < 500ms | 必須 |
| VM メモリ | 32MiB / execution | subclass で設定 |
| interrupt budget | 100k polls | remote の上限以下 |
| 同時実行 | 1 session = 1 DO（`getByName(sessionId)`） | 0203 |
| 課金 | execution 中は wall-clock | 計測 |

### 4. 失敗時の扱い

- `cf` が wasm を扱えない → この issue を **blocked** にし、code mode は Node の `openAgent` / テストだけで先に進める。CF の code profile は `profile_unavailable` のまま。
- sandbox Worker の起動失敗 → `RemoteCodemodeSandbox` の execute が `sandbox` エラー。`code` profile の `send` はエラーをモデルに返し、run を止めない。
- remote が CPU limit に当たる → `kind: "timeout"`。モデルに「計算を分割せよ」と返す。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `cf deploy --dry-run` → sandbox Worker の bundle に wasm が入る | 高 | 受入4 |
| C2 | dev 配備 → 1 script が動く | 高 | 受入5 |
| C3 | 10 秒計算中 → Session DO の `getProfile` が 500ms 以内 | 高 | 受入6 |
| C4 | binding 無し → `disabled` | 高 | 0203 |
| C5 | `npm run check` / dry-run | 高 | 受入8 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C5 | ゲート | deploy | `cf deploy --dry-run` |
| T2 | C2 / C3 | 実測 | integration（dev） | 手動 + `work/research/code-mode-sandbox.md` |
| T3 | C4 | 同値分割 | unit | 0203 のテスト |

## Notes

- 参照: pi-codemode `README.md` `Usage on Cloudflare`、`dist/cloudflare.d.ts`、pi-durable `README.md` `Code Mode`。
- `0146` は「開発・検証・配備は `cf` のみ、wrangler を直接使わない」。sandbox Worker も `cf` で配備する。`wrangler` を直接使わない。
- `cf` の wasm 対応が無い場合、選択肢は (a) `InlineCodemodeSandbox` で妥協（DO を止める）、(b) Node の別プロセス（マシン側の Python カーネル）に寄せる、(c) 上流に `cf` の wasm 対応を待つ。code mode の範囲では (a) か (b) を選ばない（決定は user）。
- 0214 は 0203 の後に置く。binding の型は 0203 が optional で持つ。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | `cf` が `.wasm` を `CompiledWasm` にできるか | できる（Wrangler 互換なら） | code mode 全体 | lead | 最初の dry-run |
| U-02 | `getByName(sessionId)` の単位 | workspace（Session DO 名） | 同時実行 | lead | 0203 |
| U-03 | 32MiB で足りるか | 足りる（RLM の script は小さい） | モデル | lead | C2 |

## やらないこと

- 0203 の Session 配線。
- Node の `CodemodeSandbox`（0200）。
- Inline sandbox への fallback 実装（必要になったら別 issue）。
- マシン側の Python カーネル。

## Log

- 2026-11-17: 作成。`cf` の wasm 対応を最初のゲートにする。

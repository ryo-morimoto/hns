# @hns/workspace

`ExecutionEnv` の上で、版つきの読み書き・Journal・認可・イベント・exec 隔離を持つ。

- `src/workspace.ts` — `Workspace.open({ env, root, journalPath, context })`。`write()` は `expectedVersion` と一致したときだけ置換し、結果は `@hns/core` の `MutationResult` で返す。
- `src/rooted.ts` / `src/rooted-helper.ts` — 解決と open / rename を dirfd でまとめる helper。Linux で exec できる環境だけ動き、それ以外は `Workspace.mode === "checks"` の経路に落ちる。
- `./sandbox` — `detectSandbox()`（bubblewrap の検出と失敗 code）と `createSandboxEnv` / `createNoExecEnv`。

```ts
import { Workspace } from "@hns/workspace";

const workspace = await Workspace.open({ env, root, journalPath, context });
const result = await workspace.write({
  path: "a.txt",
  content: "v2",
  expectedVersion: version,
  operationId: "op-1",
});
```

```bash
npm test # Node env と pi-env daemon の両方
npm run typecheck
npm run build
```

契約は [docs/workspace.md](../../docs/workspace.md)。TOCTOU の扱いは同「TOCTOU（0005）」、判断は D034 / D035。

# @hns/agent

Durable の組み立て。Workspace のツール、観測イベント、モデルのアダプタ。

- `src/agent.ts` — `openAgent()` が Harness・conversation・ツール・観測を 1 箇所で組み立てる。依存（storage / models / workspace / shell）はここで受け取り、import 時に接続しない。
- `src/session.ts` — `./session` の Worker-safe な複数会話 runtime（`openSession`）。node: を import せず、
  Session DO が使う。会話メタデータ（title / project / timestamps）は session document に置く。
- `src/tools.ts` — `read_file` / `write_file` は Workspace を通し、拒否は**値**（`{ok:false, status, message}`）でモデルに返す。
  - `write_file` の `operationId` はモデルではなく**ツール呼び出し**から作る（`call-<callId>` を wire の書式に整えたもの）。モデルが id を使い回して書き込みが消えるのを防ぐ。
  - `read_file` は 32 K 文字で切って `truncated` と `characters` を返す（`version` は全体の版）。
  - `bash` は sandbox があるときだけ登録する（無い環境では出さない）。
- `openAgent()` は `cwd` が Workspace の root 配下かを `workspace.contains()` で検査し、外なら `Denied`。
- `src/failure.ts` — 想定内の失敗の型。想定外はそのまま投げる（defect）。
- `src/events.ts` — `tool.call` / `tool.result` / `agent.response` の観測イベント。
- `src/providers/` — Ollama Cloud と OpenCode Go のアダプタ。鍵の探索は `src/keys.ts`（env → `~/.config/hns` → `.work`）。

```ts
const agent = await openAgent({ storage, models, workspace, shell, model, cwd, context, onEvent });
const turn = await agent.send("このファイルを直して");

import { openSession } from "@hns/agent/session";
import { createRegistry } from "@earendil-works/pi-durable";

const registry = createRegistry();
const session = await openSession({ storage, models, registry, model, context });
const conversation = await session.createConversation({ title: "New" });
await session.send(conversation.id, "hello");
```

```bash
npm test # faux プロバイダで実 Harness + 実 Workspace（sandbox は bwrap があれば実物）
npm run typecheck
npm run build
```

設計の根拠は [docs/typescript.md](../../docs/typescript.md)、契約は [docs/workspace.md](../../docs/workspace.md)。

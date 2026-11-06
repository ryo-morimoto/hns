# pi-agent-core 1.5.0 で agent を組めるか（実測）

2026-11-07。run.mjs が実 Workspace + 実 sandbox + faux モデルで 10/10 通る。

    cd work/poc/pi-agent
    node run.mjs

## 分かったこと

- **ツールはそのまま載る。** pi-agent-core の AgentTool は pi-ai の Tool（name / description / parameters）+
  execute(toolCallId, params, signal?, onUpdate?)。pi-durable の ToolRegistration と同じ宣言を共有するので、
  Workspace の読み書きをそのまま渡せた。版チェック（expectedVersion）・拒否（denied）・競合（conflict）はいずれも
  ツール結果の値としてモデルに届く。
- **exec も載る。** createSandboxEnv の env を execute から呼ぶだけで、root 内に書き、root 外へは出られない。
- **観測はイベントで取れる。** agent.subscribe() に agent_start / turn_start / message_* /
  tool_execution_start / tool_execution_end / turn_end / agent_end が流れる。
- **再開は「transcript を保存して戻す」で成立する。** agent.state.messages を JSON にして、
  initialState.messages で新しい Agent に戻すと、そのまま会話が続く（実測）。永続化の器は自分で用意する。
- 待ち行列（steering / follow-up）、abort()、beforeToolCall / afterToolCall フック、transport 抽象がある。

## pi-durable の Harness との差

| 項目 | pi-agent-core 1.5.0 | pi-durable Harness |
| --- | --- | --- |
| ループ・ツール実行・イベント | 持つ | 持つ |
| 会話の永続化 | **持たない**（state.messages を自分で保存） | Storage を差す |
| 障害復旧（journal / task / restart limit） | 持たない | 持つ |
| compaction / retry policy | retry は maxRetryDelayMs のみ | ポリシーとして持つ |
| 拡張・セクション・ラップ | 無い（hooks で代用） | 持つ |
| 依存 | pi-ai + pi-schema | pi-ai + codemode + telemetry + chord ほか |

**結論**: 使える。落とすのは「耐久実行」で、代わりに会話の保存・復旧を自分で持つことになる。
どちらを選ぶかは設計判断で、技術的な不可は無い。
## pi-durable と併用できるか（実測と実ソース）

**同居はできる。** 同じプロセスで、pi-durable の Harness の会話と pi-agent-core の Agent を、
同じ Models と 同じ Workspace に対して両方動かせた（run.mjs の 7 番。12/12）。

根拠（実ソース）:

- 依存は衝突しない。pi-durable 1.5.0 も pi-agent-core 1.5.0 も、pi-ai 1.5.0 と pi-schema 1.5.0 を exact pin。
  npm は 1 つに dedupe するので Context / Message / Models の型は同一。pi-durable は pi-agent-core に依存していない（別実装）。
- ただし**ループの所有者が重なる**。pi-durable の GenerationTask は runtime.models.streamSimple() を直接呼び、
  GenerationCheckpoint（prepare / request / retry / poll）を Storage に保存する。ToolTask も独自に checkpoint する。
  pi-agent-core の Agent は streamFn でモデル呼び出しだけ差し替え、状態はメモリの state.messages。
- 差し替え口が無い。pi-durable の HarnessOptions にループを渡す口は無い（models / registry / settings / env / now / timers / telemetry / identity）。
  pi-agent-core の Transport は "sse" | "websocket" | "websocket-cached" | "auto" で、実行を委譲する口ではない。

つまり **同じ会話に対しては代替**（二重ループ・二重トランスクリプトになる）。**用途を分ければ併用できる**。
## delegate 中に中断したら（実測: abort.mjs）

外側 Durable の会話でツール（delegate）が走っている最中に conversation.abort() した結果:

- submission は { status: "unanswered", reason: "aborted" } で返る。回答は生成されない。
- ツールは pi.tool-result として 1 件記録される。内容は「api.output() で出していた途中経過」+
  <harness>[error] Tool delegate was aborted</harness>。data.diagnostics は
  [{ severity: "error", code: "aborted", message: "Tool delegate was aborted" }]。
- abort 後に api.output() した内容は結果に入らない（abort 時点の slot から組み立てるため）。
- ツールの context.abortSignal は実際に発火する。ここを agent.abort() に繋いでいなければ、
  Durable は "aborted" と記録するのに内側のループは走り続ける（トークンだけ消費し、結果は捨てられる）。
- 会話は idle に戻り、次の submit を受け付ける。
- クラッシュ（プロセス kill）は別経路: 既定 replay: "unsafe" なので再実行されず、code "interrupted"
  （may have partially run）として記録され、run は unanswered / reason "interrupted" で終わる。

根拠: scheduler.js:445（mark + signal + idle 待ち）、tool.js:143（ToolTask.abort → settleFromSlot → settle）、
tool.js:657（pi.tool-result 追記）、generation.js:286（endRun unanswered/aborted）。

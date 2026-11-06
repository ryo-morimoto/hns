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
## 3つの形の比較（実測: compare.mjs / abort-compare.mjs）

同じタスク（a.txt を読んで版を答える）を、faux モデルで 3 回ずつ。数字は中央値。

| | A. pi-agent-core 単体 | B. durable in durable | C. agent-core in durable |
| --- | --- | --- | --- |
| モデル呼び出し | 2 | 4（外2 + 子2） | 4（外2 + 内2） |
| 実行時間（faux） | 44 ms | 53 ms | 45 ms |
| 内側の履歴 | 5 messages（メモリ） | 5 entries（**会話として永続**、child id 13） | 5 messages（メモリ、ツール終了で消える） |
| 残るもの | 何も残らない | 外も子も Durable storage | 外の会話だけ |
| トークン集計 | 210（内側のみ） | 571（外+子を自動で合算） | 495（外 283 + 内 212 を tool usage として手で合算） |
| 中断（delegate 中） | agent.abort() で止まる | 外の abort が子のツールまで届く（sleep が signal を受けた） | 外の abort は内側に自動では届かない。abortSignal → inner.abort() の配線が要る（実測で配線すれば止まる） |

### 読み方

- **A** は「使い捨てのループ」。永続も中断の伝播も無いが、いちばん単純で速い。C の内側はこれ。
- **B** は「子も会話」。子会話が Durable に残り、UI で別会話として見せられる。中断も所有権（ownership: task）で自動的に子へ伝わる。代償は会話とタスクが 1 段増えること（faux で +8ms。実モデルでは通信が支配的なので差は小さい）。
- **C** は「外だけ会話」。内側の途中状態は消える。中断と usage は**自分で配線**する（実測: 配線すれば止まり、usage も 212 トークンを tool usage として合算できた）。会話が 1 本で済むぶん扱いが軽い。

### 実装上の注意（実測で踏んだもの）

- B はツールの中から子会話を作る必要がある。API は api.conversation(id)（既存）しか渡さないので、PoC では harness.createConversation をクロージャで捕まえた。製品では「ツールに子会話を作る口」を注入する必要がある（api の拡張 or コンポジションルート経由）。
- B の子の回答は子会話の transcript から読む（ツールには結果テキストを直接返す API が無い）。
- C は usage を ToolExecutionResult.usage に載せないと、Durable の集計から内側の分が抜ける。
- どちらも delegate の分だけモデル呼び出しが 2 回増える（外の判断 + 外の回答）。

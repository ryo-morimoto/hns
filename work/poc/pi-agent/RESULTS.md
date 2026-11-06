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

# hns

複数マシンのAI Agentを、セルフホストの単一UIから操作するプラットフォーム。**設計段階**。

- **境界**: Agent Runtime は Pi Durable（1.5.0固定）。ファイルの安全（条件付き書き込み・Journal・認可）は Workspace 層。
- **主画面**: Conversation / Progress。Editor・Git Diff は必要時に開く。
- **実測済み**: ExecutionEnv 適合 29/29、Root 封じ込め 7/7、失更新の再現。

## 読む順

| 目的 | 場所 |
| --- | --- |
| 要件・決定・未決 | [requirements-design-state-v0.3.md](docs/requirements/requirements-design-state-v0.3.md) |
| ファイルの安全契約 | [workspace-execution-contract.md](docs/design/workspace-execution-contract.md) |
| Pi Durable の実測 | [pi-durable-1.5.0.md](docs/research/pi-durable-1.5.0.md) |
| 版固定の決定 | [0001-pi-durable-1.5.0.md](docs/decisions/0001-pi-durable-1.5.0.md) |
| **残作業** | [work/BOARD.md](work/BOARD.md) |
| 提供資料の原文 | docs/sources/ |

## 構成

```
docs/   sources / requirements / design / research / decisions
work/   BOARD.md, issues/
poc/    T-01 conformance, mutation-gap, root-containment
```

## 再実行

```bash
cd poc/env-conformance && npm install
node run.mjs local   # 29/29（pi-env daemon）
```

node はこのマシンの PATH に無い（issue 0004）。

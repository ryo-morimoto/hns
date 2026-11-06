# hns

複数マシンのAI Agentを、セルフホストの単一UIから操作するプラットフォームの設計・開発リポジトリ。

- いまの焦点と次の一手: [docs/plan/now.md](docs/plan/now.md)
- 要件・決定・未決の正本: [docs/requirements/requirements-design-state-v0.3.md](docs/requirements/requirements-design-state-v0.3.md)
- 文書の置き場所と性質: [docs/README.md](docs/README.md)

## 現在地

| 領域 | 状態 |
| --- | --- |
| 要件・責務境界（ADR-001） | 設計ベースライン採用。実装適合は未検証 |
| Agent Runtime（Pi Durable） | **1.5.0 に固定して実APIを確認済み**（[調査](docs/research/01-pi-durable-1.5.0-executionenv.md)） |
| ExecutionEnv 適合（T-01） | ローカルdaemon経由で 29/29 合格（[PoC](poc/env-conformance/)） |
| Workspace Execution Contract | [v0.1 草案](docs/design/workspace-execution-contract-v0.1.md)（実装前） |
| T-02 | 部分実施（パス/symlink 封じ込め 7/7） |
| T-03〜T-07 | 未実施 |

## 何が分かっているか（要約）

- Pi Durable の `ExecutionEnv` は **FileSystem + Shell** で、条件付き書き込み（expectedVersion）を持たない。
  「黙って上書きしない」保証は **Workspace 層が担う**（ADR-0001）。
- 原子的置換に使える `renameFile` はあるが、`writeFile` はインプレース。ツールの直列化はプロセス内限定で、
  `bash` や他プロセスとは競合しない。
- 遠隔実行は `@earendil-works/pi-env` が SSH + Rust デーモンで既に提供している。

## リポジトリ構成

```
docs/
  README.md          置き場所・文書の性質のルール
  sources/           ユーザー提供資料の原文（改変しない）
  requirements/      要件・状態記録（版単位で不変）
  research/          調査記録（時点記録、追記は新番号）
  design/            設計（生きた文書）
  decisions/         ADR（決定の記録、supersedeで更新）
  plan/              現在地・ロードマップ（生きた文書）
poc/                 検証コード（T-01等）
```

## 検証の再実行

```bash
# T-01: ExecutionEnv 適合テスト（Node環境 / pi-env daemon）
cd poc/env-conformance && npm install
node run.mjs node     # 24/29（listFiles 5件はローカルNode環境が未実装）
node run.mjs local    # 29/29（pi-env daemon 同梱の LocalExecutionEnv）
```

> このマシンでは `node` が PATH に無い（nix store から起動している）。開発環境の固定は未決（U-14）。
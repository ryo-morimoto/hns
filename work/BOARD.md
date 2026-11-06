# Board

残作業の索引。1 issue = 1ファイル（`work/issues/`）。形式は [README.md](README.md)。

| # | 作業 | 状態 | 依存 |
| --- | --- | --- | --- |
| [0001](issues/0001-t02-remainder.md) | T-02 の残り（監査・Root差し替え・Worker越し） | **done** | — |
| [0002](issues/0002-mutation-crash.md) | T-03/T-04 Mutation の故障注入 | **done** | 0001 |
| [0003](issues/0003-walking-skeleton.md) | Workspace Walking Skeleton | **done** | 0002 |
| [0004](issues/0004-dev-env.md) | 開発環境の固定（node） | open | — |
| [0005](issues/0005-toctou.md) | TOCTOU の窓を閉じる（openat2 / dirfd） | open | — |
| [0006](issues/0006-sandbox-deploy.md) | sandbox の前提（bwrap の検出・配布） | open | — |
| [0007](issues/0007-conversation.md) | 会話の実結線 | **done** | — |
| [0008](issues/0008-editor.md) | Editor の最小（dirty・保存・競合） | **done** | — |
| [0009](issues/0009-diff-view.md) | diff の表示 | **done** | 0008 |
| [0010](issues/0010-wasm-editor.md) | WASM エディタ（Want・保留） | **保留** | — |
| [0011](issues/0011-diff-limit.md) | diff の上限撤廃 | **done** | 0009 |
| [0012](issues/0012-real-provider.md) | 実 Provider（Ollama Cloud） | **done** | — |
| [0013](issues/0013-opencode-go.md) | 2プロバイダ目（OpenCode Go） | **done** | 0012 |
| [0014](issues/0014-integrated-mvp.md) | 統合 MVP（1マシン） | **done** | 0002 |
| [0015](issues/0015-progress-stream.md) | 進捗のストリーミング | **done** | 0014 |
| [0016](issues/0016-project-task.md) | Project と Task | **done** | 0014 |

## ゲート

- [0001 M2 → 会話の実結線](gates/0001-m2-to-conversation.md): **Go with Conditions（承認済み・完了）**
- [0002 統合 MVP](gates/0002-integrated-mvp.md): **Go with Conditions（承認済み・完了）**

## ユーザー判断待ち

| # | 論点 | 案 |
| --- | --- | --- |
| D-1 | D001（1.5.0固定・Workspace層） | **採用済み** |
| D-2 | 要件#2 の配置 | **A で開始**（D004、[分解](../docs/topology.md)） |
| D-3 | MVP 範囲 | **採用済み**（D003） |

## 調査・検証

- [research/pi-durable-1.5.0.md](research/pi-durable-1.5.0.md): API・適合・失更新・封じ込め
- [research/wasm-editor.md](research/wasm-editor.md): WASM・CRDT・通信の測定
- [research/](research/): 提供資料の原文（agentics / agent engineering / 開発プロセス / 設計プレイブック / 要件状態 v0.3）
- [poc/](poc/): conformance / mutation-gap / root-containment / root-swap / daemon-life / workspace-core / walking-skeleton / sandbox

## 優先度

- **UI の作り込みは最後**（D011）。今は API と契約を固める。
- 2マシン（T-05）は**一旦下げる**。1マシンの実用性を先に固める。
- 次: Project / Task（要件5・7）→ Workflow（6）。設計は [domain.md](../docs/domain.md)。

## 制約

- 危険な Tool は Worker 認可が完成するまで公開しない。
- 外部副作用の exactly-once を前提にしない。
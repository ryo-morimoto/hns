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
| [0017](issues/0017-workflow.md) | Workflow（agent/tool/human・再開） | **done** | 0016 |
| [0018](issues/0018-automations.md) | Automations（Schedule / Webhook） | **done** | 0017 |
| [0019](issues/0019-auth.md) | 認証と公開範囲（13） | **done** | 0014 |
| [0020](issues/0020-backup.md) | バックアップと復元（16） | **done** | 0014 |
| [0021](issues/0021-tailscale-auth.md) | tailnet の ID で認証（13） | **done** | 0019 |
| [0022](issues/0022-passkey.md) | passkey の登録・ログイン（13） | **done** | 0021 |
| [0023](issues/0023-prf-encryption.md) | PRF で秘密を暗号化（14） | **done** | 0022, 0024 |
| [0025](issues/0025-recovery-code.md) | 複数の包みと復旧コード（14） | **done** | 0023 |
| [0026](issues/0026-add-passkey.md) | 2台目のパスキー追加 | **done** | 0025 |
| [0027](issues/0027-usage-limits.md) | 利用量と制限（15） | **done** | 0014 |
| [0028](issues/0028-observability.md) | 観測（17） | **done** | 0014 |
| [0024](issues/0024-secret-scopes.md) | 秘密のスコープ分離（14） | **done** | 0019 |

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


## 残り（棚卸し 2026-11-06）

### 要件

| # | 状態 | 残り |
| --- | --- | --- |
| 1 セルフホスト | △ | 配布・設定・バックアップ・更新の手順がない |
| 2 複数マシン | ✗ | 下げ中（T-05） |
| 3 全マシンを1UIで | ✗ | 2 に依存 |
| 4 チャット | △ | 履歴一覧、中断、トークンのストリーミング |
| 5 プロジェクト | △ | API のみ。Workspace との関連、UI |
| 6 ワークフロー | △ | 逐次実行のみ。並列・分岐・再試行・耐久 |
| 7 タスク | △ | API のみ。Run / Conversation との関連 |
| 8 Provider | △ | 鍵の管理、OAuth、能力差の吸収 |
| 9 Editor | △ | ツリー操作、検索、構文、Git 連携 |
| 10 Git diff | ✗ | Want |
| 11 Grabber | ✗ | Want |
| 12 Automations | △ | 認証、再試行、通知 |

### 横断（要件番号）

| # | 要件 | いまの状態 |
| --- | --- | --- |
| 13 | 認証・認可と公開範囲 | token・tailnet・passkey |
| 14 | 秘密の管理 | スコープ分離・PRF・復旧コード・2台目追加 |
| 15 | 利用量と制限 | 記録・レート・予算・タイムアウト・中断（0027） |
| 16 | データの保全 | 取得・復元（0020）。定期化は未 |
| 17 | 観測 | イベント・メトリクス（0028）。時系列と外部送出は未 |
| 18 | 安全 | TOCTOU（0005）、bwrap（0006）、SSH 未検証 |
| 19 | 開発・検証基盤 | node 未固定（0004）、CI なし |
| 20 | 会話の管理 | 一覧のみ。名前・削除・検索なし |
| 21 | UI / UX の仕上げ | 最小のまま（D011） |

（ドキュメントは要件に含めない。必要になったら別枠で。）

### 下げたもの

- 2マシン（T-05）
- WASM エディタ（0010）

## 優先度

- **UI の作り込みは最後**（D011）。今は API と契約を固める。
- 2マシン（T-05）は**一旦下げる**。1マシンの実用性を先に固める。
- 次: Workflow の実用（ノード種別・再開）、API の固め。設計は [domain.md](../docs/domain.md)。

## 制約

- 危険な Tool は Worker 認可が完成するまで公開しない。
- 外部副作用の exactly-once を前提にしない。
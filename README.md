# hns

複数マシンのAI Agentを、セルフホストの単一UIから操作するプラットフォーム。**設計段階**。

## やりたいこと

1. インターフェースをセルフホストできる
2. 複数マシンで Core Agent を動かせる
3. 一箇所の UI から全マシンの Agent を操作する
4. 普通のチャットとして使える
5. プロジェクト管理
6. ワークフローグラフ設定
7. タスク管理
8. 複数 Model Provider
9. Editor（Zed の操作モデルを参考にする）
10. Git Diff Viewer（Want）
11. Web UI Grabber Extension（Want）

- Must は 1〜9。主画面は **Conversation / Progress** で、Editor First にはしない。
- 最初の利用者は「複数開発マシンを持つ個人開発者」（仮説）。
- MVP 候補: セルフホスト起動、会話、2マシン接続、権限つきファイル編集、再開。**範囲は未承認**。

## やらないこと

- Zed の見た目・GPUI の Web 移植
- Agent Loop と永続化の再実装（Pi Durable を借りる）
- チーム向け RBAC、公開 SaaS

## 状態

| 領域 | 状態 |
| --- | --- |
| 要件・決定 | 設計ベースライン（v0.3） |
| Agent Runtime | Pi Durable **1.5.0 固定**、実API確認済み |
| ファイル安全 | Workspace 契約 v0.1（実装前） |
| 検証 | T-01 29/29、T-02 部分 7/7、失更新の再現 |
| 実装 | 未着手 |

## 読む順

[ARCH.md](ARCH.md) → [docs/workspace.md](docs/workspace.md) → [docs/decisions.md](docs/decisions.md) → [work/BOARD.md](work/BOARD.md)

## 再実行

```bash
cd work/poc/env-conformance && npm install
node run.mjs local   # 29/29（pi-env daemon）
```

node はこのマシンの PATH に無い（issue 0004）。

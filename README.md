# hns

複数マシンのAI Agentを、セルフホストの単一UIから操作するプラットフォーム。**PoC 実装済み・製品化中**。

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
12. Automations（スケジュール / Webhook で Workflow・会話を起動）
13. 認証・認可と公開範囲（単一ユーザーでも入口を閉じる）
14. 秘密の管理（Provider 鍵・Webhook token の保存とローテーション）
15. 利用量と制限（コスト、レート制限、タイムアウト、中断）
16. データの保全（バックアップ・復元・スキーマ移行）
17. 観測（ログ・実行履歴・メトリクス）
18. 安全（TOCTOU の残余・sandbox の配布・SSH 経路の検証）
19. 開発・検証基盤（node の固定・CI・テスト集約）
20. 会話の管理（一覧・名前・削除・検索）
21. UI / UX の仕上げ（最終段、D011）

- Must は 1〜9 と 12〜21（10・11 は Want）。主画面は **Conversation / Progress** で、Editor First にはしない。
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
| ファイル安全 | Workspace 契約 v0.1（PoC 実装済み、移植中） |
| 検証 | 部品 156 チェック合格、統合 E2E 12/12、ドメイン 15/15、Workflow 16/16、Automation 17/17、認証 9/9・tailnet 10/10・passkey 7/7・PRF 9/9・2台目 4/4・秘密 12/12、制限 12/12、観測 17/17・網羅 5/5・会話管理 13/13、安全 10/10、バックアップ 5/5、実モデル 2プロバイダ |
| 実装 | 製品コード開始（core / store） |

## 読む順

[ARCH.md](ARCH.md) → [docs/workspace.md](docs/workspace.md) → [docs/decisions.md](docs/decisions.md) → [work/BOARD.md](work/BOARD.md)

## 開発環境

Node 24 を [flake.nix](flake.nix) で固定している（nixpkgs `nixos-25.11`、いまは Node 24.18.0 / npm 11.16.0）。
`nix-command` と `flakes` を有効にした nix を用意し、リポジトリの根から:

```bash
nix develop        # Node と npm が入ったシェルに入る
npm install
```

flake を使えない環境では Node 24.18 以降（24.x）を PATH に置く。22.x は使わない（D032）。
`node` は `nix develop` の中か `scripts/with-node.sh` 経由で実行する。

まっさらな環境からの再現:

```bash
nix develop
npm install
scripts/with-node.sh npm run check          # 製品コードのゲート
work/poc/install.sh                         # PoC の依存（隣のディレクトリを import する）
cd work/poc/app && node run.mjs             # PoC の統合 E2E
```

## 触ってみる

```bash
nix develop
work/poc/install.sh
cd work/poc/app
PROVIDER=ollama node serve.mjs ~/some/dir   # url を開く
```

表示された url を使って:

```bash
curl -s -X POST $URL/write -d '{"path":"a.txt","content":"hello","expectedVersion":"absent","operationId":"w1"}'
curl -s "$URL/read?path=a.txt"
curl -s "$URL/events?cursor=0&limit=1"
```

## 検証

すべて `nix develop` の中で、リポジトリの根から実行する。PoC の依存は先に `work/poc/install.sh` で入れる。

| 対象 | コマンド |
| --- | --- |
| T-01 適合 | `cd work/poc/env-conformance && node run.mjs local` |
| T-02 封じ込め | `cd work/poc/root-containment && node run.mjs` |
| T-02 Root同一性 | `cd work/poc/root-swap && node run.mjs` |
| exec 隔離 | `cd work/poc/sandbox && node run.mjs` |
| 会話の実結線 | `cd work/poc/conversation && node run.mjs` |
| Editor | `cd work/poc/editor && node run.mjs` |
| 統合アプリ | `cd work/poc/app && node run.mjs` |
| Project/Task | `cd work/poc/app && node run-domain.mjs` |
| Workflow | `cd work/poc/app && node run-workflow.mjs` |
| Automation | `cd work/poc/app && node run-automation.mjs` |
| 認証 | `cd work/poc/app && node run-auth.mjs` |
| tailnet 認証 | `cd work/poc/app && node run-tailscale.mjs` |
| passkey | `cd work/poc/app && node run-passkey.mjs` |
| PRF 暗号化 | `cd work/poc/app && node run-prf.mjs` |
| 2台目のパスキー | `cd work/poc/app && node run-addpasskey.mjs` |
| 利用量と制限 | `cd work/poc/app && node run-limits.mjs` |
| 観測 | `cd work/poc/app && node run-observe.mjs` |
| 網羅（全イベント） | `cd work/poc/app && node run-journal.mjs` |
| 会話の管理 | `cd work/poc/app && node run-conversations.mjs` |
| 安全 | `cd work/poc/app && node run-safety.mjs` |
| まとめて検査 | `scripts/check.sh`（oxlint / oxfmt / tsc / build） |
| 秘密 | `cd work/poc/app && node run-secrets.mjs` |
| バックアップ | `cd work/poc/app && node run-backup.mjs` |
| 実モデル（要キー） | `cd work/poc/conversation && PROVIDER=opencode MODEL_ID=deepseek-v4.1-flash node real.mjs` |
| T-03/T-04 | `cd work/poc/workspace-core && node run.mjs` |
| Walking Skeleton | `cd work/poc/walking-skeleton && node run.mjs` |

Node 24 は [flake.nix](flake.nix) が固定する（issue 0004）。`nix develop` か `scripts/with-node.sh` を通して実行する。
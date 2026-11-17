# AGENTS.md

hns は、複数のマシンの AI エージェントを 1 つの UI から運用するセルフホストのプラットフォーム。npm workspaces のモノレポ。

このファイルは**ルーティングだけ**。作業の前に、その作業に必要な文書を読む。規範は `docs/procedures/`、契約は `docs/contracts/`、不変条件は `docs/invariants.md` にあり、ここには置かない。

## 最初に決めること

- **着手してよいのは `priority: now` の issue だけ**。`now` は `design: agreed` かつ依存が満たされている。agent が自分で昇格しない（[BOARD.md](work/BOARD.md)）。
- 1 issue = 1 branch = 1 worktree。**変更レーンは最大 3 本**（[parallel-change.md](docs/procedures/parallel-change.md)）。
- 完了は「`npm run check` が通り、**この変更を書いていない agent が PASS**」の両方。片方だけでは完了でない（[review.md](docs/procedures/review.md)）。
- **push しない**。commit はローカルに留める。共有ファイル（`work/BOARD.md`・`work/LANES.md`・`docs/decisions.md`・他レーンの issue）は、その所有者の commit が落ち着くまで触らない。

## どの文書を読むか

| 何を決めるか | 読むもの |
| --- | --- |
| 何を作るか・優先度 | [work/BOARD.md](work/BOARD.md)、担当 issue |
| モジュール境界・型の置き場 | [docs/packages.md](docs/packages.md)、[docs/architecture.md](docs/architecture.md) |
| 面の契約（失敗・ファイル・Journal・観測） | [docs/contracts/](docs/contracts/README.md) |
| 不変条件（破ったら間違い） | [docs/invariants.md](docs/invariants.md) |
| 設計の規則とその条件 | [docs/design.md](docs/design.md) |
| テストの書き方・層 | [docs/procedures/testing.md](docs/procedures/testing.md) |
| 並行変更・レーン | [docs/procedures/parallel-change.md](docs/procedures/parallel-change.md) |
| レビューの観点 | [docs/procedures/review.md](docs/procedures/review.md) |
| 工程・リリース | [docs/procedures/process.md](docs/procedures/process.md) |
| なぜこうなったか | [docs/decisions.md](docs/decisions.md) |
| 型のレビュー・TypeScript の流儀 | [docs/type-review.md](docs/type-review.md)、[docs/typescript.md](docs/typescript.md) |

## 実行

`nix develop` の中で動かす（Node 26 は `flake.nix` が固定）。

```bash
nix develop
npm install
npm run check        # 全 stage（lint / fmt / codegen / typecheck / build / test / deploy / knip）
npm run gate         # staged の範囲だけ（commit 前）
npm test -w @hns/store
```

- `npm run check` は `build` を含む。**レーンで事前に `npm run build` をしない**。
- worktree では `node_modules` の解決がメイン checkout を向く。build / typecheck / codegen の前に [process.md](docs/procedures/process.md) の「並行変更」の手順を読む。

## 守ること（短く）

- **型が正本**。`any` を書かない。`as` は根拠コメント付きで最小に。unions は閉じ、`switch` は `never` で終える。
- **`unknown` は parse するまで `unknown`**。DB 行・HTTP body・環境変数は境界で valibot に通す。
- **失敗は型付き**。GraphQL は union、REST は閉じた failure union。想定内の失敗と欠陥（500）を混ぜない。
- **秘密を出さない**。鍵は `~/.config/hns/`。ログはパスと status だけ。
- **fail closed**。認可・sandbox・root の同一性は、確かめられなければ拒否する。
- 既存の guard / helper を探してから書く。新しい抽象は 2 つ目の利用者が出てから。
- 生成物（SDL・relay・`deploy/assets`）は手で編集せず、生成コマンドで作り直す。

## 補足

- 要件と全体像: [README.md](README.md)、[ARCH.md](ARCH.md)。
- PoC（`work/poc/`）は製品コードではない。機能を足さない。

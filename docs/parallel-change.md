# 並行変更（変更レーン）

2026-11-10 / D060。同時に流す変更を「変更レーン」として扱い、2本から3本に増やす条件と運用を固定する。

D049 の「レーン」（L0〜L9）は**設計の所有単位**で、製品のどの部分を誰が持つかを表す。ここで言う変更レーンは
**実行の単位**で、いま同時に流している変更（1 issue / 1 ブランチ / 1 owner）を表す。同じ語だが軸が違う。
設計レーンは BOARD、実行レーンは [work/LANES.md](../work/LANES.md) に分ける。

## 原則

レーン数を増やす目的は、変更のリードタイムを下げること。並列度そのものを上げることではない。

| 原則                               | 根拠                                                                                                                                                                                                                 | 崩れたときの症状                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 小さく、頻繁に統合する             | 統合の頻度が高いほど1回のマージは小さくなる（[Fowler](https://martinfowler.com/articles/branching-patterns.html)）                                                                                                   | 長期ブランチ、巨大な競合                                                              |
| 開発は並列、統合は直列             | 統合の瞬間だけ順番を付ける（[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）                       | 個々に green でも結合で壊れる（[merge skew](https://graphite.com/guides/merge-skew)） |
| 名前空間と契約で分ける             | モジュール性が高いほど並行変更は衝突しない（Fowler）                                                                                                                                                                 | 同じファイルの奪い合い、意味的な競合                                                  |
| 部分実装を main に出せる           | [flag](https://martinfowler.com/bliki/FeatureToggle.html) / [branch by abstraction](https://martinfowler.com/bliki/BranchByAbstraction.html) / [expand-contract](https://martinfowler.com/bliki/ParallelChange.html) | レーンが巨大化し、完成まで統合できない                                                |
| 依存は明示し、満たすまで着手しない | `depends-on` / [stacked diffs](https://graphite.com/guides/stacked-diffs)                                                                                                                                            | 先回り、手戻り、二重実装                                                              |
| ボトルネックを測ってから増やす     | [Little's law](https://en.wikipedia.org/wiki/Little%27s_law) `L = λW`、[TOC](https://en.wikipedia.org/wiki/Theory_of_constraints)                                                                                    | レーンを増やしたのにリードタイムが伸びる                                              |

Little's law は、系の中の変更数 `L` が、到着率 `λ` と滞在時間 `W` の積になるという関係。レビューや統合の
処理能力が上がらないまま `L` を増やすと、`W` が伸びる。3本目は処理能力に余裕があるときだけ足す。

## システム設計としての見方

変更レーンは、システムのモジュール境界と契約に写像する。境界が曖昧なまま並列度を上げると、ファイル競合ではなく
**意味的な競合**（同じ概念を別々に実装する）が増える。依存は DAG で持ち、クリティカルパス上のレーンを先に統合する
（[DSM](https://en.wikipedia.org/wiki/Design_structure_matrix)）。開発は楽観的に並列、統合は悲観的に1本ずつ、が基本の構え。

## 変更レーンの定義

| 項目     | 条件                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 単位     | 1 issue = 1 目的。ついでの整形・改名・依存追加を混ぜない                                                                                   |
| ブランチ | `issue/NNNN-slug` を main から切る。1 issue 1 ブランチ                                                                                     |
| 書き込み | issue の `touches` のパスだけ。共有ファイルは「直列化点」に従う                                                                            |
| owner    | 1 人（agent）。同じ owner が2レーンを兼ねない                                                                                              |
| reviewer | そのレーンを書いていない別 agent。実装とレビューを分ける                                                                                   |
| 寿命     | 1日を目標、2日を上限。超えたら分割する（[短命ブランチ](https://trunkbaseddevelopment.com/short-lived-feature-branches/)）                  |
| 大きさ   | 1つの自己完結した変更。目安は100行、1000行は大きすぎる（[Google](https://google.github.io/eng-practices/review/developer/small-cls.html)） |
| 完了     | review PASS + `npm run check` + main へ rebase + 統合 + 統合後の確認                                                                       |

寿命の2日は「レビュー待ちを含む」。待ちが長いレーンは、作業が終わっていても短命ブランチではない。

## レーンの種類

| 種類       | 役割                                                     | `touches`                                  |
| ---------- | -------------------------------------------------------- | ------------------------------------------ |
| 変更レーン | 1 issue を実装する。E1 / E2 など                         | issue の `touches`                         |
| 統合レーン | 他のレーンの rebase・review・merge・計測と、運用の文書化 | 運用ドキュメントだけ。製品コードは持たない |

3本目は変更レーンでなくてもよい。統合待ちがリードタイムを支配しているときは、統合レーンを1本置く方が速い。
統合レーンは実装しない。実装とレビューを同じレーンに混ぜない。

## 3本の前提

変更レーンを3本にするときの前提。変更2本 + 統合1本の構成でも、変更レーンには同じ条件を課す。
次をすべて満たすときだけ3本目を開く。1つでも欠けるなら2本に戻す。

- [ ] **依存**: 3つとも `priority: now` で、`depends-on` がすべて満たされている。
- [ ] **名前空間**: 3つの `touches` が交わらない。共有ファイルは所有者と統合順が決まっている。
- [ ] **レビュー**: 各レーンに、そのレーンを書いていない reviewer がいる。レビュー待ちが作業時間を超えていない。
- [ ] **統合**: 一度に1本だけ統合する。統合のたびに rebase と `npm run check` を行い、main が赤なら統合を止める。
- [ ] **契約**: レーンを跨ぐ境界（型・schema・API・DB）は先に固定されている。破壊的変更は expand → migrate → contract に分ける。
- [ ] **隠す手段**: 未完成の振る舞いを main に出しても、利用者や他のレーンに見えない（flag・未公開・別 entry point）。
- [ ] **戻し方**: revert するか flag を切る。どちらも即日にできる。
- [ ] **計測**: リードタイム、レビュー待ち、統合待ち、競合、ゲート時間、統合後の失敗を記録する。
- [ ] **停止条件**: どれかが崩れたら、レーンを増やさず2本に戻す。

## 運用

### レーンの状態

[work/LANES.md](../work/LANES.md) に、少なくとも次を書く。

| 列               | 意味                                                |
| ---------------- | --------------------------------------------------- |
| レーン           | E1 / E2 / E3                                        |
| issue            | 1 issue だけ。複数 issue を1レーンに詰めない        |
| 所有するパス     | `touches` の写し。重なりを見るためのもの            |
| owner / reviewer | 実装者とレビュアー。同じ人にしない                  |
| 状態             | 作業中 / レビュー待ち / 統合待ち / 止まっている理由 |
| 次の統合         | 1, 2, 3 の順。依存が少ない・小さい順に決める        |

### 日次

1. **開始**: 3つの issue、owner、reviewer、`touches`、統合順を確認する。満たさないレーンは開かない。
2. **作業**: レーン内は直列。依存先のファイルを先回りしない。共有ファイルは所有者の merge 後にする。
3. **統合**: 1本ずつ。rebase → `npm run check` → review PASS → merge。merge 後に main で再確認する。
4. **終了**: レーンの状態、レビュー待ち、統合待ち、競合、翌日の統合順を BOARD に戻す。

### 統合の順番

- 依存が少ない → 多い。小さい → 大きい。
- 同じファイルを触るレーンは、先の merge 後に rebase する。共有ファイルは所有者が先。
- 2本が同時に green でも、結合で壊れることがある（merge skew）。統合後の確認を省かない。
- main が赤なら、新しい merge を止め、直すのを最優先にする。
- コンフリクトを手工で解消したら、その統合は再 review する（[review.md](review.md)）。

### パッケージ内の分割

並列の単位は `packages/*` ではなく **`touches` のファイル**。同じパッケージでもサブツリーが分かれていれば
並列にしてよい（例: `server/src/edge/` と `server/src/do/`）。判断するのは次の2つ。

- **サブツリー**: 同じディレクトリに入るレーンは、merge の前に `touches` のファイルが交わらないことを確認する。
- **共有ファイル**: 次のファイルは1レーンだけが触る。他はその merge 後に rebase する。
  `package.json` / `package-lock.json`（lock owner）、`packages/server/src/index.ts`、
  `packages/server/src/edge/handler.ts`、`tools/deploy/worker.ts`、`tools/deploy/cloudflare.config.ts`、
  `work/BOARD.md` / `work/LANES.md`（lead）。

### 増やす・減らす

| 状況                                                     | 判断       | 理由                                        |
| -------------------------------------------------------- | ---------- | ------------------------------------------- |
| 3つ目の `now` が独立していて、レビューと統合に余裕がある | 3本にする  | リードタイムが下がる                        |
| レビュー待ちが作業時間より長い                           | 増やさない | ボトルネックはレビュー。3本目は待ちを増やす |
| 2本の `touches` が同じファイルで重なる                   | 増やさない | 共有ファイルの所有者が決まっていない        |
| main が赤い                                              | 増やさない | 統合能力がない。まず直す                    |
| 3本目が2本の未マージに依存する                           | 増やさない | 先回りになる。依存が解けてから開く          |
| 1本が外部待ちで止まっている                              | 入れ替える | 4本目を足さず、止まったレーンを外す         |

## アンチパターン

| 症状                                | 原因                     | 直し方                                                          |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------- |
| 3本が同じファイルを触る             | 名前空間が分かれていない | サブツリーかファイルで分割する。共有ファイルは所有者を1人決める |
| reviewer が1人で3本を見る           | レビューがボトルネック   | レーンを減らすか、レビューを分担する                            |
| レーンが2日を超える                 | 大きすぎる               | issue を分割する。flag で一部を先に出す                         |
| 統合後に壊れる                      | merge skew               | 統合後チェック、統合順の固定、rebase                            |
| レーンを増やしたのに遅い            | WIP 過多                 | Little's law。ボトルネックを直してから増やす                    |
| レーンが止まっているのに4本目を開く | WIP を隠している         | 止まったレーンを外す。4本目は開かない                           |

## 計測

| 指標         | 見方                        | 目安                    |
| ------------ | --------------------------- | ----------------------- |
| リードタイム | ブランチ開始から merge まで | 2日以内。超えたら分割   |
| レビュー待ち | review 依頼から PASS まで   | リードタイムの半分以下  |
| 統合待ち     | PASS から merge まで        | ゲート1回分以内         |
| 競合         | merge 時のコンフリクト件数  | 5回に1回以下            |
| ゲート時間   | `npm run check` の時間      | 現在の2倍を超えない     |
| 統合後の失敗 | main が赤になった回数       | 0。起きたら統合を止める |

数値は目標ではなく警報。超えたらレーンを増やすのではなく、ボトルネックを直す。

## 出典

- [Patterns for Managing Source Code Branches](https://martinfowler.com/articles/branching-patterns.html) — 統合頻度、モジュール性、feature flag
- [Continuous Integration](https://martinfowler.com/articles/continuousIntegration.html) — 少なくとも1日1回の統合
- [Short-Lived Feature Branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/) — ブランチ寿命は2日程度。レビュー待ちも寿命に含む
- [Software Engineering at Google, ch16](https://abseil.io/resources/swe-book/html/ch16.html) — trunk-based と長期ブランチのコスト
- [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html) — 100行を目安、1000行は大きすぎる
- [Stacked diffs](https://graphite.com/guides/stacked-diffs) — 依存を明示した小さな変更の積み上げ
- [Merge skew](https://graphite.com/guides/merge-skew) — 個々に green でも結合で壊れる
- [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) — 統合候補をまとめて検証してから merge する
- [Feature Flag](https://martinfowler.com/bliki/FeatureToggle.html) / [Branch by Abstraction](https://martinfowler.com/bliki/BranchByAbstraction.html) / [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html) — 部分実装を main に出す
- [Little's law](https://en.wikipedia.org/wiki/Little%27s_law) — `L = λW`
- [Theory of constraints](https://en.wikipedia.org/wiki/Theory_of_constraints) — ボトルネックが全体の throughput を決める
- [Design structure matrix](https://en.wikipedia.org/wiki/Design_structure_matrix) — 依存の見える化
- [DORA metrics](https://dora.dev/guides/dora-metrics-four-keys/) — リードタイム、デプロイ頻度、失敗率、復旧時間

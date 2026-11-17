# Work tracking

残作業と検証はこのディレクトリ。

- `BOARD.md`: 状態・依存・並列の索引（`now` と止まっている理由だけ。型は [issue-format.md](issue-format.md)）。
- `issues/NNNN-slug.md`: 1 issue 1ファイル。**Goal / Acceptance / Log の 3 節**（[issue-format.md](issue-format.md)）。設計は issue に書かない。
- `research/`: 提供資料の原文と実測ノート。書き換えない。
- `poc/`: 検証コード。
- `scratch/`: gitignore。

## 優先度（重要度 × 緊急度）

| priority | 重要度 | 緊急度 | 意味 |
| --- | --- | --- | --- |
| `now` | 高 | 高 | いまの波。依存が満たされていて、すぐ着手してよい |
| `next` | 高 | 低 | 重要だが、いまの波の後。レーンの順に上げる |
| `later` | 低 | 中 | 安い・隣接するときだけ。単独では着手しない |
| `parked` | — | — | いまはやらない（Want・保留・新しい設計に吸収） |

- **agent が着手してよいのは `now` だけ。** `now` が空なら止まって人に聞く。
- `next` を `now` に上げるのは人の判断。agent が自分で昇格しない。
- 一覧と件数は [BOARD.md](BOARD.md) の「優先度マトリクス」。変えるときは issue と BOARD を同時に直す。

## 設計の合意（design）

`priority` は**いつやるか**、`design` は**設計が人間と合意できているか**。別の軸として持つ。
`next` は「この波の後」と「設計が未合意」を兼ねない。

| design | 意味 | now にできるか |
| --- | --- | --- |
| `agreed` | 設計が人間、または記録済みの決定（DNNN / docs の節）と合意している | できる（依存と枠が満たされれば） |
| `pending` | 重要だが設計が未合意（未判定・rescope 待ちを含む） | できない。設計レビューで `agreed` にする |

- `design: pending` は、設計レビュー（D069 の設計層）で `design-ref` に根拠（DNNN / docs の節）を書いて `agreed` にする。レビューは実装前に行う。
- `now` の条件は **`design: agreed` かつ `depends-on` 充足**。`next` は、設計・依存・枠のどれかが理由で `now` ではない状態で、BOARD は理由（設計待ち / 順番待ち / 依存待ち）で分ける。
- 設計を変えない issue（欠陥の返済・docs・メタデータ）は `agreed` とし、`design-ref: 設計を変えない（理由）` と書く。
- 完了した issue は `design` を持たない。既存の done は遡及しない。新規 issue は `design: pending` で作り、設計レビューで `agreed` にする。

## Issue 形式

`superseded` は置換済み。後継の issue 番号を本文の先頭に書き、状態は変えない。

```markdown
# NNNN: Title

status: open | in-progress | blocked | done | superseded
priority: now | next | later | parked
design: agreed | pending
design-ref: DNNN / docs の節（agreed のとき）
depends-on: NNNN, NNNN
touches: 触るパス

## Intent
（誰のどの課題を、なぜ今か。レコードの intent と揃える）

## Goal
## Acceptance criteria
- [ ] 検証できる形で書く
## テスト条件
- C1: Given / When / Then（リスク、出所）
## テスト設計
- T1: 条件 / 技法 / 層 / テスト
## Notes
## 未確定
- U-01: 何が / 仮説 / 影響 / 責任者 / 期限かトリガー
## やらないこと
## Log
## Result
```

完了の記録は 1 issue 1 レコード（D067）。置き場とスキーマは [0195](issues/0195-work-record-contract.md) で決める（YAML は D067）。決まるまで Result は verdict / reviewer / HEAD / blocking を書く。

振る舞いを変える issue は「テスト条件」と「テスト設計」を書く。テストとコードに issue 番号を書かない（issue 側からパスを参照する）。

review の要否と記録は [docs/review.md](../docs/review.md) と [review/process.md](../docs/review/process.md)。対象なら記録に最終 verdict（PASS / BLOCKED）・reviewer・HEAD・
blocking 指摘とその修正 commit を書き、途中の FAIL は `## Log` に残す。対象外なら理由を1行書く。
どちらも無い issue は `done` にしない。

## 並列作業

1 issue = 1 ブランチ = 1 変更レーン。`issue/NNNN-slug` を main から切る。
同時に流すのは**最大3本**で、増やす条件は [docs/parallel-change.md](../docs/parallel-change.md) の「3本の前提」を
すべて満たすこと。2本から3本に増やすのは人の判断で、agent は自分でレーンを増やさない。
[LANES.md](LANES.md) に、issue / owner / reviewer / `touches` / 次の統合を書く。

- `touches` は契約。書いていないファイルは触らない。必要になったら、先に issue の `touches` を更新する。
- `depends-on` が未マージなら着手しない。依存先のファイルを先回りして変えない。
- `package.json` / `package-lock.json` を触る issue は同時に1つ（lock owner）。依存を足さない issue は触らない。
- 並列の単位はパッケージではなく **`touches` のファイル**。同じ `packages/*` でもサブツリーが分かれていれば並列可
  （例: `server/src/edge/` と `server/src/do/`）。守るのは次の2つ。
- 共有ファイルは所有者を1レーンに決め、他は統合直前に rebase する。`package.json` / `package-lock.json`
  （lock owner）、`packages/server/src/index.ts`、`packages/server/src/edge/handler.ts`、`tools/deploy/worker.ts`、
  `tools/deploy/cloudflare.config.ts`、`work/BOARD.md` / `work/LANES.md`（lead）。
- 統合は一度に1本。rebase → `npm run check` → review PASS → merge。merge 後に main でもう一度確認する。
- main が赤なら、新しい統合を止めて直すのを最優先にする。
- レーンが外部待ち・依存待ちで止まったら、4本目を足さず、そのレーンを入れ替える。
- マージ前に main へ rebase し、`npm run check` を通す。コンフリクトを手工で解消したら再 review（[docs/review.md](../docs/review.md)）。マージ後に壊れたら、マージした側が直す。
- 1 issue 1目的。ついでの整形・改名・依存追加を混ぜない。
- `## やらないこと` に、その issue でやらないことと、先回りしない将来作業を書く。

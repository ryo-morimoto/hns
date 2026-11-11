# hns house style

このリポジトリ（hns）で RFC / design doc を書くときの置き場所とルール。
一般論は [../SKILL.md](../SKILL.md)、golden examples は [golden-examples.md](golden-examples.md)、レビューは [review-checklist.md](review-checklist.md)。

## 置き場所

standalone の `docs/rfc/` は作らない。既存の work tracking と docs に落とす。
issue は [../templates/hns-issue.md](../templates/hns-issue.md)、decision は [../templates/hns-decision.md](../templates/hns-decision.md) の形にする。

| 何 | どこ | ルール |
| --- | --- | --- |
| proposal / contract / 実装の約束 | `work/issues/NNNN-*.md` | 1 issue = 1 目的。`status` / `priority` / `depends-on` / `touches` を header に置く |
| 決定 | `docs/decisions.md` | append-only。DNNN、date、by、issue。古い決定は消さず、新しい決定で上書きする |
| 設計の原則 | `docs/design.md` | 条件 → 命令 → 補足 → Ref。設計前に読み、レビュー前に該当領域だけ読む |
| 契約・仕様 | `docs/*.md` | flat spec。実装と同じ変更で更新する |
| アーキテクチャ・不変条件 | `ARCH.md` | 所有境界、主要フロー、INV-xx |
| 状態・並列の索引 | `work/BOARD.md`、`work/LANES.md` | `priority: now` だけ着手可。レーンは最大3本 |
| skill | `.agents/skills/` | このリポジトリのプロジェクト skill。DSH が `project-agents` として読む |

## Issue の形式

```markdown
# NNNN: Title

status: open | in-progress | blocked | done | superseded
priority: now | plan | batch | hold
depends-on: NNNN, NNNN
touches: path, path

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

- **Goal** は「何を達成するか」。solution の説明にしない。
- **Acceptance criteria** は検証できる形にする。「動く」ではなく「X のとき Y が Z になる」。
- **テスト条件 / テスト設計** は、振る舞いを変える issue で書く。テスト設計はコードを書く前の別ステップ。
- **未確定** は U-xx で管理する。owner / trigger / 期限を書く。TBD だけにしない。
- **やらないこと** は、今回やらないことと、先回りしない将来作業。real な non-goal を書く。
- **Log** は日付つきの履歴。**Result** は verdict / reviewer / HEAD / blocking と修正 commit。
- issue 番号は code / test / TODO に書かない。issue 側からパスを参照する。

## 決定ログ

`docs/decisions.md` は append-only。

- 形式: `## DNNN: 決定の1文`、`date: YYYY-MM-DD · by: user | agent | coordinator · issue: NNNN`、本文。`by` は既存の決定で使われている値（coordinator を含む）。
- `hns:` の補足と `前提が変わる条件` は任意。既存の決定ではよく使われているが、必須の field ではない。
- 決定を変えるときは、古い決定を書き換えない。新しい DNNN を足し、古い決定を参照して上書きする。
- 却下した案と理由を残す。後から「なぜこうしたか」を辿れるようにする。
- 決定が実装に埋もれないように、issue / docs / ARCH からリンクする。

## 設計の原則

- `docs/design.md` の条件・命令・補足・Ref を読む。矛盾したときは AGENTS.md → design.md → review.md の順。
- 型は `packages/core/src/types.ts` が正本。schema は型に合わせる（`v.GenericSchema<unknown, T>`）。
- 保存形式（`archived: 0 | 1`、JSON 文字列、連番）は store の内側に閉じる。公開モデルは `parse*` の後。
- 想定内の失敗は型で返す。`any` を使わない。`as` には `// SAFETY:` を付ける。
- 新しい抽象化は2つの call site ができてから。既存の guard / helper を先に探す。
- 生成物は再生成する。ヘッダーと再生成コマンドを残す。

## レビュー

- 実装後に、コードを書いていない独立レビューを受ける。`docs/review.md` を読む。
- blocking は「この変更で生まれた重大・高・中」。前からある問題は issue 候補に分ける。
- 指摘は「重大度 / file:line / 観測（実行結果・型・テスト・経路） / 修正案 / blocking か」。
- checklist の blocking / comment / nit は、hns では「この変更が生んだ重大・高・中 = blocking、低・好み = comment / nit」と対応する。
- 修正 diff は再レビューする。blocking 0 で PASS。
- `npm run check` は「壊れていない」ことの証明ではない。レビューの代わりにしない。
- Result に verdict / reviewer / HEAD / blocking findings を残す。どちらも無い issue は done にしない。

## テスト

- テストはコードの隣。unit は `packages/<pkg>/src/<module>.test.ts`、integration は `packages/<pkg>/test/integration/`、E2E は `e2e/`。
- 振る舞いをテストする。内部 helper 名・log 文言・CSS をテストしない。
- 失敗 path（invalid input、illegal transition、conflict、unknown enum）をカバーする。
- Vitest の `expect` を使う。型の narrowing は `node:assert` / `expect.assert`。
- TSDoc が契約。exported API と重要な internal function に precondition / invariant / error / example を書く。
- TSDoc の `@example` doctest は小さな純関数・公開契約に使う。
- issue と TSDoc が test management の唯一の artifact。テストが証明。

## 書き方

- docs は日本語、識別子は英語。見出しは内容が分かる名前にする。
- 相対リンクはリポジトリルートから辿れる形にする。リンク切れを残さない。
- 1 issue 1 目的。ついでの整形・改名・依存追加を混ぜない。
- commit message は `area: summary`。push はユーザーの指示があるまでしない。
- 「RFC を書きたい」と言われたら、standalone の RFC ではなく、issue + decision + contract docs に落とす。issue は [../templates/hns-issue.md](../templates/hns-issue.md)、decision は [../templates/hns-decision.md](../templates/hns-decision.md) を使う。
- 設計の変更は、実装と同じ変更で docs / ARCH / decisions を更新する。docs は契約。

## hns で RFC を書く流れ

1. `work/issues/NNNN-*.md` を作る。Goal / Acceptance criteria / テスト条件 / テスト設計 / 未確定 / やらないこと。
2. 必要なら `docs/decisions.md` に DNNN を追記する。決定・却下案・前提が変わる条件。
3. 契約を `docs/*.md` と `ARCH.md` に書く。所有境界・不変条件・主要フローを更新する。
4. 実装 issue / PR とリンクする。実装が RFC とずれたら、RFC を amend するか新しい decision にする。
5. 独立レビューと `npm run check`。Result に verdict / reviewer / HEAD / blocking を残す。
6. status を更新する。古い決定は消さず、supersede する。

## 参照

- [AGENTS.md](../../../../AGENTS.md)
- [docs/design.md](../../../../docs/design.md)
- [docs/process.md](../../../../docs/process.md)
- [docs/review.md](../../../../docs/review.md)
- [docs/testing.md](../../../../docs/testing.md)
- [docs/decisions.md](../../../../docs/decisions.md)
- [work/README.md](../../../../work/README.md)

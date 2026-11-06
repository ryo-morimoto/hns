# レビューの進行と記録

author が読む。誰に何を渡すか、指摘が出た後にどうするか。reviewer が見る手順と判定は [review.md](../review.md)。

## 対象

`packages/*/src`、`packages/*/test`、`vitest.config.ts`、依存（`package.json` / lock）、規範と主張を書いた `docs/`、
AGENTS.md、work/README.md を変える変更は、コミット前に1回。整形・誤字・コメントだけが対象外。除外は Result に1行残す。
rebase でコンフリクトを手工で解消したら、解消後の diff も対象（「挙動は変わらない」は author が決めない）。

## 渡すもの

- 実装していない別 agent。author の説明と自己申告を正解として扱わない（テストがあることは正しさではない）。
- `git diff <base>..HEAD -- packages docs package.json package-lock.json vitest.config.ts AGENTS.md work/README.md`、
  受入条件、必要な環境と再現コマンド。
- author は依頼前に同じ観点を1回通す。

## 直し方

- blocking は直してから出す。非 blocking は PASS でも残件に列挙し、issue にする。
- **規則は1箇所。** 直すときに同じ検査を2層に足さない。足したら片方を消す。
- **回帰テストは、直す前のコードで落ちることを確かめる。** 落ちないならテストか直しのどちらかが間違っている。
- **直したら、同じ reviewer に修正 diff を再 review させる。** 直しは新しい欠陥の入口で、hns でも2件出た
  （`"tool:" + callId` が自分の `OperationIdSchema` に違反、64 KiB が文字単位で JSON を壊す）。

## 記録

issue の `## Result` に最終 verdict・reviewer・HEAD・blocking 指摘と修正 commit を書く。途中の FAIL / BLOCKED は `## Log`。
書いていない issue は `done` にしない。2026-11-07 以降の issue が対象で、既存の `done` には遡及しない。

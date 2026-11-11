# Review checklist

RFC / design doc のレビューは、文章の添削ではなく **decision が安全に決められるか** の確認。
この checklist は、読む順ではなく **抜けを探す順** に使う。全部を機械的に要求しない。変更の重さに合わせて選ぶ。

## Severity

| severity | 意味 | 例 |
| --- | --- | --- |
| **blocking** | このままでは契約が破れる・危険・決められない。修正なしで承認できない | decision が不明、problem が無い、real な alternative が無い、failure mode が無い、breaking change に移行計画が無い、security / privacy の重大な穴、複数の提案が混在 |
| **comment** | 実質的な指摘だが、単独では承認を止めない。著者が判断する | 根拠が弱い、用語が曖昧、例が足りない、adoption / teaching が薄い、open question に owner が無い、長すぎる |
| **nit** | 好み・表記・形式。blocking に数えない | typo、見出しの粒度、表の整形 |

blocking の前に、必ず**反証を1回**試す。「この指摘は本当に契約を破るか」「著者の前提が正しいとしたら成立するか」を確認する。
evidence は「section / 引用 / 実行結果 / 経路」で示す。推測だけの blocking は出さない。

## Output

```text
Verdict: PASS / FAIL / BLOCKED

Blocking:
- [severity] section — observation — fix

Comments:
- section — observation — suggestion

Nits:
- section — observation

Checked:
- ...

Not checked:
- ...

Open questions:
- ...
```

PASS は blocking 0。FAIL は blocking あり。BLOCKED は前提・環境・依存が揃わず確認できない場合。
「読んだが見ていない」を PASS にしない。

## Change weight

すべての項目を同じ重さで要求しない。変更の重さで profile を選ぶ。

| profile | 例 | blocking にするもの | comment でよいもの |
| --- | --- | --- | --- |
| small issue | bugfix、小さな refactor、自明な変更 | decision / problem / security / compatibility の穴 | options / invariants / test plan の薄さ（ただし危険なら blocking） |
| design doc | 合意済み方向の実装計画 | design / failure / compatibility / test plan | 長さ・表現・future work |
| RFC / platform | cross-team、公開契約、インフラ、移行 | 全次元。特に options / invariants / compatibility / graduation | 表現・nit |

以下の severity は **RFC / design doc の default**。small issue では、profile に従って comment に落とす。

## hns との対応

hns のレビューは `docs/review.md` の severity（重大 / 高 / 中 / 低）と blocking フラグを使う。

- **blocking** = この変更が生んだ重大・高・中。前からある問題は issue 候補に分ける。
- **comment** = 低（blocking でないもの）、または著者が判断する改善。
- **nit** = 好み・表記・typo。
- 指摘の形式: `重大度 / file:line / 観測（実行結果・型・テスト・経路） / 修正案 / blocking か`。
- `## Result` には verdict / reviewer / HEAD / blocking findings を残す。

## 1. Decision & status

- [ ] **何を決める文書か、1文で言えるか。** Red flag: 目的が「〜を検討する」「〜を改善する」だけで、decision が無い。Severity: blocking.
- [ ] **decision owner と approver が明記されているか。** Red flag: 誰が決めるか不明、著者と承認者が同一で、独立レビューが無い。Severity: blocking.
- [ ] **status が正しいか。** draft / review / accepted / rejected / superseded のどれか。Red flag: 古い status のまま、review 中なのに accepted。Severity: comment（誤解を招くなら blocking）.
- [ ] **decision の期限・review period があるか。** Red flag: いつまでに決めるか不明。Severity: comment.
- [ ] **supersedes / related が書かれているか。** Red flag: 過去の決定を置き換えるのに参照が無い。Severity: comment（履歴が壊れるなら blocking）.

## 2. Problem & evidence

- [ ] **problem が solution から独立して書かれているか。** Red flag: solution が先、problem が後付け。Severity: blocking.
- [ ] **誰が困っているか、具体的か。** Red flag: 「開発者」「ユーザー」だけで、具体的な person / role / scenario が無い。Severity: blocking.
- [ ] **根拠があるか。** Red flag: 体験談だけ、再現手順・数値・ログ・顧客の声が無い。Severity: comment（意思決定の根拠なら blocking）.
- [ ] **なぜ今か。** Red flag: 緊急性・機会・依存の説明が無い。Severity: comment.
- [ ] **prior art を調べているか。** Red flag: 過去の RFC / issue / 他言語の実装に触れていない。Severity: comment（同じ失敗を繰り返すなら blocking）.

## 3. Users & use cases

- [ ] **代表的な use case が 2〜3 個あるか。** Red flag: 「みんな」「あらゆる場面」。Severity: blocking.
- [ ] **各 use case で、今どうしているか。** Red flag: 現状の workaround が書かれていない。Severity: comment.
- [ ] **non-user / out-of-scope user が明確か。** Red flag: 誰を対象外にするか不明。Severity: comment.
- [ ] **operator / developer / support への影響が考えられているか。** Red flag: end user だけ。Severity: comment（運用が破れるなら blocking）.

## 4. Scope & non-goals

- [ ] **goals が測定可能か。** Red flag: 「使いやすくする」「速くする」だけ。Severity: comment（成功判定ができないなら blocking）.
- [ ] **non-goals が real か。** Red flag: 「バグらない」「遅くならない」など品質の前提。Severity: blocking（scope が読めない場合）.
- [ ] **non-goal が solution の選択に効いているか。** Red flag: non-goal を書いたが、設計に反映されていない。Severity: comment.
- [ ] **scope が1つの decision に収まっているか。** Red flag: 複数の独立した提案が混在。Severity: blocking.
- [ ] **やらないことを future work と混ぜていないか。** Red flag: future work が実質的な scope の逃げ。Severity: comment.

## 5. Options & trade-offs

- [ ] **最低2案があるか。** Red flag: 1案だけ、または「他に無い」。Severity: blocking（RFC / design doc） / comment（small issue）.
- [ ] **do nothing / 現状維持が検討されているか。** Red flag: 現状維持の cost が書かれていない。Severity: comment（比較が成立しないなら blocking）.
- [ ] **反対案が straw man でないか。** Red flag: 明らかに弱い案だけ。Severity: blocking.
- [ ] **各案の cost / risk / benefit があるか。** Red flag: 利点だけ、コスト・リスクが無い。Severity: blocking（比較できない場合）.
- [ ] **採用しなかった理由が書かれているか。** Red flag: 代替案は並ぶが、なぜ落としたか不明。Severity: blocking.

## 6. Design & invariants

- [ ] **guide-level の説明があるか。** Red flag: 仕様だけ、使い方・例が無い。Severity: blocking.
- [ ] **reference-level の仕様があるか。** Red flag: 概念だけ、API / data / algorithm が無い。Severity: blocking.
- [ ] **用語が定義されているか。** Red flag: 新しい用語が説明なしで使われる。Severity: comment（誤解が設計に影響するなら blocking）.
- [ ] **invariants が明示されているか。** Red flag: 「常に成り立つこと」が無い。Severity: blocking（RFC / design doc） / comment（small issue）.
- [ ] **境界・順序・冪等性が書かれているか。** Red flag: 並行・再送・重複の扱いが無い。Severity: blocking.
- [ ] **既存機能との interaction が書かれているか。** Red flag: 単体では動くが、既存の機能と衝突する。Severity: blocking.

## 7. Failure & edge cases

- [ ] **失敗時の振る舞いがあるか。** Red flag: happy path だけ。Severity: blocking.
- [ ] **unknown を applied / failed に丸めていないか。** Red flag: 結果不明を成功・失敗のどちらかに倒す。Severity: blocking.
- [ ] **再送・重複・競合が扱われているか。** Red flag: 冪等性・operation id が無い。Severity: blocking.
- [ ] **部分失敗・タイムアウト・プロセス停止・電源断があるか。** Red flag: 途中で落ちたときの状態が不明。Severity: blocking.
- [ ] **入力の信頼境界が書かれているか。** Red flag: client / DB / env をそのまま信じる。Severity: blocking（security に影響する場合）.
- [ ] **silent failure をどう観測するか。** Red flag: 失敗しても log / metric / alert が無い。Severity: comment（運用が破れるなら blocking）.

## 8. Cross-cutting

- [ ] **security が独立して考えられているか。** Red flag: 最後の1行だけ、認可・入力・秘密の扱いが無い。Severity: blocking（security surface がある場合） / comment（surface が無い small issue）.
- [ ] **privacy / 個人情報 / データ所在地が考えられているか。** Red flag: 保存するデータ・保持期間・アクセス範囲が不明。Severity: blocking（法務・信頼に影響する場合）.
- [ ] **observability（log / metric / trace / audit）があるか。** Red flag: 何を観測するか不明。Severity: comment（障害対応に必要なら blocking）.
- [ ] **operability（deploy / rollback / runbook / on-call）があるか。** Red flag: 運用の変更が無視されている。Severity: blocking（運用が破れる場合）.
- [ ] **cost が試算されているか。** Red flag: 保存・compute・egress・人のコストが無い。Severity: comment（予算を超える可能性があるなら blocking）.
- [ ] **performance の目標・測定があるか。** Red flag: 「速い」だけで p95 / p99 / throughput が無い。Severity: comment（性能が主目的なら blocking）.
- [ ] **accessibility / i18n（UI 変更なら）が考えられているか。** Red flag: UI の変更なのに言及が無い。Severity: comment.

## 9. Compatibility & migration

- [ ] **何が壊れるか列挙されているか。** Red flag: source / binary / wire / data / behavior のどれかが不明。Severity: blocking（breaking change の場合）.
- [ ] **移行手順があるか。** Red flag: codemod / flag / dual-write / backfill が無い。Severity: blocking（breaking change の場合）.
- [ ] **rollback があるか。** Red flag: 戻せない、戻すと何が失われるか不明。Severity: blocking（危険な変更の場合）.
- [ ] **version skew が考えられているか。** Red flag: 古い client / server の混在で壊れる。Severity: blocking（分散システムの場合）.
- [ ] **破壊的変更の必要性が説明されているか。** Red flag: 互換性を捨てる理由が「簡単だから」。Severity: blocking.

## 10. Test & acceptance

- [ ] **acceptance criteria があるか。** Red flag: 「動いたら完了」。Severity: blocking（RFC / design doc / risky change） / comment（small issue）.
- [ ] **test plan があるか。** Red flag: unit / integration / e2e / fault injection のどれも無い。Severity: blocking（ risky change の場合）.
- [ ] **成功 metrics があるか。** Red flag: 何をもって成功とするか不明。Severity: comment（判断できないなら blocking）.
- [ ] **graduation criteria があるか。** Red flag: alpha / beta / GA の条件が無い。Severity: comment（段階的 rollout なら blocking）.
- [ ] **テストできない部分の扱いが書かれているか。** Red flag: 未テストを黙って通す。Severity: comment（危険なら blocking）.

## 11. Adoption & teaching

- [ ] **既存ユーザーの移行が書かれているか。** Red flag: 新規ユーザーだけ。Severity: comment（breaking change なら blocking）.
- [ ] **docs / example / training があるか。** Red flag: API だけ、使い方が無い。Severity: comment.
- [ ] **feature flag / opt-in があるか。** Red flag: いきなり全員に影響。Severity: comment（危険なら blocking）.
- [ ] **サポート / on-call への周知があるか。** Red flag: 運用チームが知らない。Severity: comment.

## 12. Open & ownership

- [ ] **未解決が明示されているか。** Red flag: 未解決を隠す、または「無い」と断言。Severity: comment（設計の穴なら blocking）.
- [ ] **各 open question に owner がいるか。** Red flag: TBD だけ。Severity: comment（decision を止めるなら blocking）.
- [ ] **trigger / 期限があるか。** Red flag: 「いつか決める」。Severity: comment.
- [ ] **future work と open question が分かれているか。** Red flag: 将来の話で今の穴を覆う。Severity: comment.

## 13. Writing & reviewability

- [ ] **summary が短く、decision と why を言っているか。** Red flag: 背景だけで decision が無い。Severity: comment.
- [ ] **1文1アイデアか。** Red flag: 長い文に複数の主張。Severity: nit/comment.
- [ ] **用語が一貫しているか。** Red flag: 同じものを別名で呼ぶ。Severity: comment.
- [ ] **例が具体的か。** Red flag: 抽象論だけ。Severity: comment.
- [ ] **長さが適切か。** Red flag: 1〜3 pages で足りる変更に 20 pages。Severity: comment.
- [ ] **リンク・参照が正しいか。** Red flag: リンク切れ、存在しない issue。Severity: comment（根拠が辿れないなら blocking）.

## 14. Process & record

- [ ] **コメント期間 / review の方法が決まっているか。** Red flag: いつ誰がレビューするか不明。Severity: comment.
- [ ] **designated reviewer がいるか。** Red flag: 著者だけでレビュー。Severity: blocking（独立レビューが要件なら）.
- [ ] **反対意見・不採用理由が残るか。** Red flag: 反対意見を消す、decision だけ書く。Severity: blocking（履歴が失われる場合）.
- [ ] **decision record（ADR / decision log）とリンクしているか。** Red flag: RFC だけ残り、決定が辿れない。Severity: comment（契約なら blocking）.
- [ ] **実装 issue / owner / link があるか。** Red flag: 承認後に誰が何をするか不明。Severity: comment（handoff が無いなら blocking）.

## Planted-issue exercise

レビューの練習用。次の欠陥を仕込んだ RFC を読んで、いくつ拾えるか確認する。

1. solution が最初に来て、problem が後付けになっている。
2. non-goals が「バグらないこと」だけ。
3. alternative が明らかに弱い straw man で、do nothing が無い。
4. failure modes が無く、unknown を failed に丸めている。
5. breaking change なのに migration / rollback が無い。
6. 「2倍速くなる」とだけ書かれ、数値・機序・測定方法が無い。
7. open question が「TBD」だけで、owner も trigger も無い。
8. 認証の変更と UI の変更という2つの提案が1文書に混在している。

期待する review:

- 1, 3, 4, 5, 8 は **blocking**。
- 2, 6, 7 は **comment**（ただし 2 は scope が読めないなら blocking、6 が主目的なら blocking、7 が decision を止めるなら blocking）。
- それぞれ、section / observation / fix を付ける。
- 「読んでいない部分」を checked に混ぜない。

## hns での追加チェック

hns の issue / docs では、次も確認する。

- [ ] `## Goal` / `## Acceptance criteria` / `## テスト条件` / `## テスト設計` があるか。
- [ ] `## 未確定` の U-xx に owner / trigger があるか。
- [ ] `## やらないこと` が real か。
- [ ] `## Result` に verdict / reviewer / HEAD / blocking が残るか。
- [ ] `docs/decisions.md` に決定が追記されているか（append-only）。
- [ ] code / test に issue 番号を書いていないか。
- [ ] `npm run check` と独立レビューの証拠があるか。

詳しくは [hns-house-style.md](hns-house-style.md)。

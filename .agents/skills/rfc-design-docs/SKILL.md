---
name: rfc-design-docs
description: Use when drafting or reviewing an RFC, design doc, ADR, PR/FAQ, or technical proposal, especially when the decision is cross-team, long-lived, or has multiple viable designs.
---

# RFC と設計ドキュメント

RFC と design doc は「正しい実装」を書くためのものではなく、**決めるべきことを決め、後から理由を辿れるようにする**ためのもの。
この skill は、書く前の判断、書く順序、節の構成、レビューの gate、よくある失敗を1か所にまとめる。

参照:

- [references/golden-examples.md](references/golden-examples.md) — Rust / Next.js / React / Kubernetes / Python / Go / Swift / TC39 / IETF / Google / Amazon / ADR / Shape Up の型
- [references/review-checklist.md](references/review-checklist.md) — 72項目 + hns 7項目のレビュー checklist
- [references/hns-house-style.md](references/hns-house-style.md) — このリポジトリ（hns）での置き場所と書き方
- 参考（他リポジトリ向け）: [templates/rfc.md](templates/rfc.md) / [templates/design-doc.md](templates/design-doc.md) / [templates/adr.md](templates/adr.md) / [templates/pr-faq.md](templates/pr-faq.md)
- hns 用: [templates/hns-issue.md](templates/hns-issue.md) / [templates/hns-decision.md](templates/hns-decision.md)

## いつ使うか / いつ使わないか

使う:

- 複数チーム・複数パッケージにまたがる契約を変える。
- 後から戻すのが高い決定（保存形式、公開 API、依存、認証、データ所在地）。
- 実装方法が1つに決まらず、trade-off を比べる必要がある。
- 長く残る決定で、後から「なぜこうしたか」を辿る必要がある。
- 顧客・利用者に見せる product / policy の提案。

使わない:

- bugfix、typo、小さな refactor、自明な rename。
- 既に合意済みの方向の単なる実装。実装計画は design doc か issue で足りる。
- 1つの decision を ADR に書けば足りるもの。
- まだ問題自体が曖昧で、調査 issue の方が適切なもの。

**書かない判断も設計**。Google の design doc 文化でも、trade-off が無い・実装マニュアルになるなら書かない。
1〜3 pages の mini design doc で足りる変更に 20 pages を使わない。

## まず成果物を選ぶ

| 必要なもの | 成果物 | 長さの目安 | 何を決めるか |
| --- | --- | --- | --- |
| cross-team / long-lived / public contract | RFC | 5〜20 pages（hns では issue + 分割 docs） | 方向と設計の骨格 |
| 合意済み方向の実装計画 | design doc | 3〜10 pages | 実装上の選択 |
| 1つの architecture decision | ADR | 1〜2 pages | その決定 |
| customer / product の提案 | PR/FAQ | 2〜6 pages（hns では issue の proposal） | go / no-go |
| time-boxed な bet | pitch | 2〜5 pages（hns では 1-page brief） | 何をいつまでに |
| 小さな変更 | issue / PR | 短く | 実装の可否 |

迷ったら、**軽い方から始める**。Go はまず proposal issue、必要なら design doc。Rust も pre-RFC 的な相談を推奨している。
重い文書は、重さに見合うだけの不確実性・影響範囲があるときだけ使う。

hns では、独立した RFC ファイルを作らない。[templates/hns-issue.md](templates/hns-issue.md) の issue に design の節を置き、契約の詳細は `docs/*.md` / `ARCH.md` に分ける。
decision は [templates/hns-decision.md](templates/hns-decision.md) で `docs/decisions.md` に追記する。pitch は独立ファイルを作らず、issue の 1-page decision brief として書く。

## 10 の問い

どんな成果物でも、次の10問に答えられれば骨格はできる。

1. **Decision**: 何を決めるのか。誰が決めるのか。今の status は何か。いつまでに決めるのか。
2. **Problem**: 誰のどんな問題か。根拠は何か。なぜ今か。solution を抜きにしても説明できるか。
3. **Users / use cases**: 誰が使うのか。代表的な scenario は何か。「みんな」になっていないか。
4. **Scope / non-goals**: 何をやるか。何を**やらない**と決めたか。それは本当に選ばなかった目標か。
5. **Options / trade-offs**: どんな代替案があるか。do nothing は検討したか。それぞれの cost / risk / benefit は何か。
6. **Recommendation**: どれを推すか。なぜ goals に一番合うのか。どんな assumption の上に立っているか。
7. **Design**: 使う人にどう教えるか（guide-level）。実装者が再現できる仕様は何か（reference-level）。不変条件・境界・失敗時の振る舞いは何か。
8. **Failure / cross-cutting**: 何が壊れ得るか。競合・再送・部分失敗・unknown はどう扱うか。security / privacy / observability / operability / cost / performance / accessibility はどうか。
9. **Compatibility / evidence**: 何が壊れるか。どう移行し、どう戻すか。どうテストし、何を成功とみなすか。graduation / metrics は何か。
10. **Open / record**: 何が未解決か。owner は誰か。いつ・何を trigger に決めるか。future work は何か。決定と反対意見をどこに残すか。

## 書く順序

1. **1-page decision brief** を書く。decision / problem / goals / non-goals / options / recommendation / risks / open questions。まずこれだけでレビューする。
2. まだ曖昧なら、context / problem / evidence を厚くする。solution は後。
3. goals と non-goals を箇条書きにする。non-goal は「今回やらない、選ばなかった目標」。
4. options を並べ、do nothing を含めて trade-off を表にする。
5. recommendation を書き、guide-level の説明を書く。用語を定義し、具体例を出す。
6. reference-level の設計を書く。API / data / algorithm / invariant / edge case。
7. failure modes と cross-cutting を書く。happy path の後に必ず。
8. compatibility / migration / rollback を書く。
9. test / acceptance / graduation を書く。
10. open questions と future work を分けて書く。owner / trigger を付ける。
11. **summary は最後**に書く。5 文以内。専門用語を避け、decision と why を書く。

行組みは、レビューしやすさを優先する。Go の design doc は 80 columns・1 sentence per line を推奨している。
長い段落は分割し、レビュアーが行単位で指せるようにする。

## 標準の構成

### Header

- Title
- Status（draft / review / accepted / rejected / superseded）
- Authors / Decision owner
- Date / Review period
- Supersedes / Related

status と owner を冒頭に置く。Next.js の RFC は Status / Target / Scope を最初に置いている。
Swift は review manager / implementation / feature flag まで header に置く。必要な情報は冒頭に集める。

### Summary

- 5 文以内。decision と why。
- 専門用語を避け、out-of-context でも読めるようにする。
- Swift の 50 words summary、Kubernetes の Summary が参考。

### Context and problem

- 事実と現状。何が起きているか。
- 誰が困っているか。再現手順、数値、ログ、顧客の声。
- 現在の workaround とその限界。
- prior art（他の言語・プロダクト・過去の提案）。
- 制約（時間、予算、互換性、法務、運用）。

**solution を書かない**。problem と solution を混ぜると、problem が solution の正当化になる。

### Users and use cases

- 具体的な user / operator / developer と scenario。
- 「みんな」ではなく、代表性のある 2〜3 例。
- それぞれ、今どうしているか、何が足りないか。

### Goals

- 達成したいこと。可能なら測定可能に。
- 優先順位を付ける。全部を goal にしない。

### Non-goals

- 今回はやらないこと。**選ばなかった目標**を書く。
- 「壊れない」「遅くならない」は non-goal ではない。品質の前提。
- non-goal が無いと、レビューで scope が膨らむ。

### Options and trade-offs

- 最低2案。可能なら「do nothing」も。
- 表: option / 概要 / 利点 / 欠点 / リスク / コスト / 採用条件。
- straw man を置かない。反対案にも一番強い形で書く。
- 採用しなかった理由を、後から読む人に分かるように書く。

### Recommendation

- どの案を推すか。なぜ goals に合うか。
- どんな assumption に依存するか。それが崩れたらどうするか。
- 採用しなかった案をどう扱うか（future work / 別 RFC / 却下）。

### Design: guide-level

- すでに採用されたものとして、使い方を教える。
- 新しい概念・用語を定義する。
- 具体例、before / after、エラーメッセージ、移行例。
- 既存の利用者と新規の利用者で教え方が違うなら、その差を書く。
- Rust の guide-level explanation が参考。

### Design: reference-level

- 実装者が再現できる仕様。
- API / data / algorithm / state machine / invariant。
- 境界条件、順序、冪等性、再送、競合、部分失敗。
- 既存機能との interaction。
- コードを貼るなら最小限。schema のコピペより、設計に関係する部分だけ。
- Rust の reference-level explanation、Kubernetes の Design Details が参考。

### Invariants and failure modes

- 常に成り立つこと（invariant）。
- 失敗したとき何が残るか。unknown を applied / failed に丸めていないか。
- 再送・重複・競合・タイムアウト・プロセス停止・電源断・ネットワーク分断。
- security / privacy の失敗（漏えい、権限昇格、入力信頼）。
- 観測できない失敗（silent failure）をどう可視化するか。

### Cross-cutting concerns

- Security / privacy / compliance
- Observability（log / metric / trace / audit）
- Operability（deploy / rollback / runbook / on-call）
- Cost（storage / compute / egress / 人）
- Performance（latency / throughput / p95 / p99）
- Accessibility / i18n（UI の変更なら）
- 既存の cross-cutting review が要るなら、その review をいつ・誰がやるか。

Google の design doc は cross-cutting concerns を独立した節にしている。最後の飾りにしない。

### Compatibility, migration, rollback

- 何が壊れるか（source / binary / wire / data / behavior）。
- 移行手順。codemod、feature flag、dual-write、backfill。
- ロールバック。戻せるか、戻すと何が失われるか。
- version skew。古い client / server が混在しても動くか。
- 破壊的変更なら、なぜ必要か、代替はないか。

### Test plan and acceptance

- unit / integration / e2e / property / fault injection。
- acceptance criteria。何ができたら完了か。
- 成功 metrics。latency、error rate、coverage、cost。
- graduation criteria（alpha / beta / GA）。Kubernetes の KEP が参考。
- テストできない部分は、なぜできないか、どう観測するか。

### Rollout and graduation

- 段階的 rollout。canary、flag、opt-in。
- 監視と abort 条件。
- docs / support / training。
- 次の段階に進む条件。

### Open questions

- 未解決のこと。owner / trigger / 期限。
- 「RFC 中に決める」「実装中に決める」「将来の RFC で決める」を分ける。
- TBD だけ書かない。誰がいつ決めるかまで書く。

### Future work

- 今回はやらないが、自然な拡張。
- 今の RFC の採否とは独立。future work に書いたからといって、今の提案の理由にしない。

### References

- prior art、データ、prototype、関連 issue / RFC / ADR。
- リンクは相対パスか完全 URL。リンク切れを残さない。

## golden examples からの variation

- **Rust RFC**: guide-level / reference-level、Drawbacks、Rationale and alternatives、Prior art、Unresolved questions、Future possibilities。FCP と shepherd。
- **Next.js RFC**: Status / Target / Scope / Proposed API、Goals / Non-goals、semantics、100% incrementally adoptable。
- **React RFC**: Motivation を solution と独立、Basic example、Detailed design、Drawbacks、Alternatives、Adoption strategy、How we teach this、Unresolved questions。
- **Kubernetes KEP**: metadata、Goals / Non-goals、User stories、Risks and Mitigations、Test Plan、Graduation Criteria、Upgrade / Downgrade、Version Skew、PRR、Implementation History。
- **Python PEP**: 1 PEP = 1 proposal、Standards Track / Informational / Process、champion / sponsor、editor review と acceptance の区別。
- **Go design doc**: まず proposal issue、必要なら design doc。Abstract / Background / Proposal / Rationale / Compatibility / Implementation / Open issues。
- **Swift Evolution**: header の status / review manager / implementation、50 words summary、Source / ABI compatibility、Implications on adoption、Alternatives、Future directions。
- **TC39**: Stage 0〜4 の entrance criteria、champion、designated reviewer、consensus、non-consensus の記録、Test262、conditional advancement。
- **IETF RFC**: Abstract / Introduction / Requirement Language / Security Considerations / IANA / References。RFC 2119 の規範語。
- **Google design docs**: Context and scope / Goals and non-goals / design / alternatives / cross-cutting。10〜20 pages、mini design doc、書かない判断、lifecycle。
- **Amazon PR/FAQ**: customer から逆算、press release、problem / solution、customer quote、internal FAQ、top reasons it won't succeed。
- **ADR**: 1 decision = 1 record。Context / Decision / Status / Consequences。supersede しても消さない。
- **Shape Up pitch**: Problem / Appetite / Solution / Rabbit holes / No-gos。時間を先に固定する。

詳しい「何を盗むか / 盗まないか」は [references/golden-examples.md](references/golden-examples.md)。

## レビューの gate

レビューは「文章の添削」ではなく、**decision が安全に決められるか**の確認。

- **Gate 0: artifact** — RFC / design doc / ADR / PR/FAQ / issue のどれが適切か。重すぎないか、軽すぎないか。
- **Gate 1: framing** — decision、problem、users、goals / non-goals、options が揃っているか。solution-first でないか。
- **Gate 2: design** — guide-level と reference-level が揃っているか。invariants / failure modes / edge cases があるか。代替案が real か。
- **Gate 3: safety & compatibility** — security / privacy / observability / cost / performance が考えられているか。互換性・移行・rollback があるか。
- **Gate 4: evidence** — test plan / acceptance / metrics / graduation があるか。主張に数値・機序・リンクがあるか。
- **Gate 5: record** — open questions に owner / trigger があるか。反対意見と決定理由が残るか。status / supersedes が正しいか。
- **Gate 6: handoff** — 実装 issue / owner / link があるか。docs / ADR を更新する計画があるか。

各 gate の具体的な checklist と severity は [references/review-checklist.md](references/review-checklist.md)。
severity は **blocking / comment / nit** の3段階。blocking は「このままでは契約が破れる・危険・決められない」に限定する。

## よくある失敗

| 失敗 | 症状 | 直し方 |
| --- | --- | --- |
| Solution-first | problem が solution の後付け | problem を solution 抜きで書き直す |
| No non-goals | scope が無限に膨らむ | 選ばなかった目標を明示する |
| Straw man | 反対案が弱すぎる | 反対案を一番強い形で書き、採用しない理由を書く |
| Implementation manual | trade-off が無く、コードの説明だけ | なぜその設計か、代替案は何かを書く |
| Happy path only | 失敗・競合・互換が無い | failure modes / compatibility を独立した節にする |
| Unbacked claims | 「速い」「スケールする」に根拠が無い | 数値・機序・測定方法を書く |
| Multiple proposals | 1文書に複数の決定 | 分割する。1文書1決定 |
| No owner / status | 誰がいつ決めるか不明 | header に owner / status / date を置く |
| TBD without owner | 未解決が放置される | owner / trigger / 期限を付ける |
| Erased dissent | 反対意見・不採用理由が消える | decision record に残す。supersede で履歴を保つ |
| Docs drift | 実装と docs がずれる | 実装 issue と docs をリンクし、変更時に更新する |
| Security last | security / privacy が最後の1行 | cross-cutting を独立した節にし、review を計画する |
| Too long | 読まれない | 1〜3 pages の mini design doc に縮める。詳細は appendix / link |

## プロセス

1. **Preflight**: prior art を検索する。stakeholder に話す。decision question を1文にする。artifact を選ぶ。
2. **Draft**: 1-page decision brief を書く。必要なら full doc に展開する。summary は最後。
3. **Review**: コメント期間を設ける（Rust の FCP、React の final comment period が参考）。designated reviewer を決める。severity / evidence で指摘する。反対意見を記録する。
4. **Decide**: status、decision owner、日付、rationale、dissent を残す。必要なら ADR に1ページで落とす。supersede / amend の経路を決める。
5. **Implement**: 実装 issue / PR とリンクする。RFC と実装がずれたら、RFC を amend するか新しい decision にする。
6. **Maintain**: status を更新する。古い決定は消さず、supersede する。docs / runbook / tests を実装と同じ変更で更新する。

## hns での使い方

このリポジトリでは、standalone の `docs/rfc/` を作らず、既存の work tracking と docs に落とす。

- proposal / contract: `work/issues/NNNN-*.md`
- decision: `docs/decisions.md`（append-only。DNNN、date / by / issue）
- design rules: `docs/design.md`
- contract docs: `docs/*.md`、`ARCH.md`
- status / parallel work: `work/BOARD.md`、`work/LANES.md`

issue では `## Goal` / `## Acceptance criteria` / `## テスト条件` / `## テスト設計` / `## 未確定` / `## やらないこと` / `## Result` を使う。
RFC の design 節（Problem / Users and use cases / Goal（測定可能な goal を含む）/ Non-goals / Options / Recommendation / Design / Failure / Compatibility / Test plan / Notes）は、[templates/hns-issue.md](templates/hns-issue.md) の形で issue に置く。
契約の詳細（型・schema・不変条件・フロー）は `docs/*.md` / `ARCH.md` に分け、decision は [templates/hns-decision.md](templates/hns-decision.md) で `docs/decisions.md` に追記する。
ページ数の目安は「issue 本文 + 分割 docs」の合計に当てる。1つの issue を 15 pages にしない。
独立レビュー、`npm run check`、blocking の定義は `docs/review.md`。
詳しくは [references/hns-house-style.md](references/hns-house-style.md)。

## 参照

- [references/golden-examples.md](references/golden-examples.md)
- [references/review-checklist.md](references/review-checklist.md)
- [references/hns-house-style.md](references/hns-house-style.md)
- [templates/rfc.md](templates/rfc.md)
- [templates/design-doc.md](templates/design-doc.md)
- [templates/adr.md](templates/adr.md)
- [templates/pr-faq.md](templates/pr-faq.md)
- [templates/hns-issue.md](templates/hns-issue.md)
- [templates/hns-decision.md](templates/hns-decision.md)

外部の一次資料は `references/golden-examples.md` にリンクをまとめてある。

# Golden examples

これは「正解集」ではなく、**盗むべき型のカタログ**。プロジェクトの規模・文化・決定の重さに合わせて選ぶ。
リンクは 2026-11-11 時点で確認したもの。外部資料の主張は、そのままではなく自分の文脈で検証する。

## 一覧

| 資料 | 成果物 | 主に学ぶこと |
| --- | --- | --- |
| Rust RFCs | RFC | problem / guide-level / reference-level / drawbacks / alternatives / prior art / unresolved / future |
| Rust API Guidelines | API checklist | naming / interoperability / docs / predictability / type safety / future-proofing |
| Next.js RFCs | RFC / discussion | status / target / scope / proposed API / goals / non-goals / incremental adoption |
| React RFCs | RFC | motivation / basic example / detailed design / drawbacks / adoption / teaching |
| Kubernetes KEPs | KEP | goals / non-goals / risks / test plan / graduation / upgrade-downgrade / PRR |
| Python PEPs | PEP | 1 proposal = 1 PEP / types / sponsor / editor review / acceptance |
| Go design docs | design doc | proposal issue first / abstract / background / rationale / compatibility / implementation / open issues |
| Swift Evolution | proposal | header status / short summary / source-ABI compatibility / adoption |
| TC39 | stage process | stage gates / champion / reviewers / consensus / tests / implementations |
| IETF RFCs | standard | structure / normative keywords / security considerations / references |
| Google design docs | design doc | context / goals / non-goals / trade-offs / alternatives / cross-cutting / lifecycle |
| Amazon PR/FAQ | product proposal | customer problem / press release / FAQ / top reasons it won't succeed |
| ADRs | decision record | context / decision / status / consequences / supersede |
| Shape Up pitch | pitch | problem / appetite / solution / rabbit holes / no-gos |
| Next.js REVIEW.md | review rubric | severity / evidence / scope / trade-offs / no drive-bys |

## Rust RFCs

**What it is.** Rust の言語・ライブラリ・Cargo・プロセス変更の RFC。`0000-template.md` が標準構成。
"substantial" な変更だけ RFC にし、bugfix や小さな変更は PR でよい、と明記している。

**What it does well.**

- Motivation を solution から切り離し、具体的な use case で書く。
- **Guide-level explanation** と **Reference-level explanation** を分ける。前者は「すでに採用されたものとして教える」、後者は「実装者が再現できる仕様」。
- Drawbacks / Rationale and alternatives / Prior art / Unresolved questions / Future possibilities を必須に近い形で置く。
- FCP（final comment period）は10日。subteam 全員の sign-off、disposition（merge / close / postpone）、必要なら summary comment。議論の結論を PR に残す。
- 受理後の変更は amend、大きな変更は新しい RFC。RFC を不変に近く保つ。

**Steal.**

- problem → use cases → guide-level → reference-level の順。
- 「なぜ採用しないか」を alternatives に書く。
- unresolved と future を分ける。
- コメント期間と、反対意見を含む決定理由の記録。

**Don't copy.**

- Rust の subteam / FCP の制度を、そのまま小さいチームに持ち込まない。必要なのは「期間」と「決定の記録」。
- 言語仕様並みの reference-level を、小さな product 変更に要求しない。

Links: [README](https://github.com/rust-lang/rfcs), [template](https://github.com/rust-lang/rfcs/blob/master/0000-template.md), [language policy](https://github.com/rust-lang/rfcs/blob/master/lang_changes.md), [library policy](https://github.com/rust-lang/rfcs/blob/master/libs_changes.md), [compiler policy](https://github.com/rust-lang/rfcs/blob/master/compiler_changes.md)

## Rust API Guidelines

**What it is.** Rust の API 設計ガイドラインと checklist。naming / interoperability / macros / documentation / predictability / flexibility / type safety / dependability / debuggability / future-proofing / necessities に分かれる。

**What it does well.**

- 「良い API」を観点ごとに分解し、checklist としてレビューに使える。
- naming、共通 trait、エラー型、ドキュメント例、将来の破壊的変更を防ぐ sealed trait など、具体的。
- API の変更が RFC の中心なら、この checklist を追加で使う。

**Steal.**

- API を変える RFC では、naming / error / docs / compatibility / future-proofing を独立して確認する。
- checklist は「読む順」ではなく「抜けを探す順」に使う。

**Don't copy.**

- 言語固有の trait 名や `Debug` の話を、別言語の API にそのまま当てない。抽象化して使う。

Links: [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/), [checklist](https://github.com/rust-lang/api-guidelines/blob/master/src/checklist.md)

## Next.js RFCs

**What it is.** Next.js は feature の前に GitHub Discussions の RFC category で議論する。`contributing/core/adding-features.md` は「まず discussion、次に RFC」と説明している。
RFC は「incrementally adoptable / no breaking changes」を強く意識する。

**What it does well.**

- RFC の冒頭に **Status / Target / Scope / Proposed API** を置く（WebSocket RFC）。
- Goals と Non-goals を明示する。
- API の semantics（いつ handler が走るか、失敗時どうなるか）を具体例で書く。
- Layouts RFC は Motivation / Terminology / How Routing Currently Works / Introducing the app Directory / Defining Routes / Layouts / Pages / React Server Components / Data Fetching / Route Groups / Server-Centric Routing / Instant Loading / Error Handling / Templates / Advanced Routing Patterns / Conclusion と、**現状 → 変更 → 例 → 移行** を丁寧に辿る。
- 「100% incrementally adoptable」を最初に宣言し、既存ユーザーを壊さないことを設計制約にする。

**Steal.**

- 冒頭の status / target / scope。
- goals / non-goals と「壊さない」制約。
- 具体的な API semantics と before / after。
- 移行性を設計の一部にする。

**Don't copy.**

- Next.js のマーケティング的な長さ・トーンを、内部 RFC にそのまま持ち込まない。
- Discussion の大量のコメントを、そのまま設計文書にしない。決定と根拠を抽出する。

Links: [RFC category](https://github.com/vercel/next.js/discussions/categories/rfc), [adding features](https://github.com/vercel/next.js/blob/canary/contributing/core/adding-features.md), [Layouts RFC](https://nextjs.org/blog/layouts-rfc), [WebSocket RFC](https://github.com/vercel/next.js/discussions/95514), [Deployment Adapters RFC](https://github.com/vercel/next.js/discussions/77740)

## React RFCs

**What it is.** React の substantial change の RFC。`0000-template.md` は Summary / Basic example / Motivation / Detailed design / Drawbacks / Alternatives / Adoption strategy / How we teach this / Unresolved questions。

**What it does well.**

- Motivation を solution と独立に書く。RFC が却下されても motivation は別解に使える、と明記している。
- Basic example を最初に置き、読者が具体的に想像できるようにする。
- Drawbacks で implementation cost、user space でできるか、教育への影響、移行コストを挙げる。
- Adoption strategy と How we teach this を独立した節にする。API だけでなく、教え方・移行・docs を設計する。
- Community RFC は「merge されること」だけでなく、議論・研究・別解の材料になる、と位置づける。

**Steal.**

- Motivation を solution から独立させる。
- Basic example / Drawbacks / Adoption / Teaching を節にする。
- 却下された RFC も learning として残す。

**Don't copy.**

- React の API surface の狭さ・チームの文脈を、そのまま一般化しない。

Links: [reactjs/rfcs](https://github.com/reactjs/rfcs), [template](https://github.com/reactjs/rfcs/blob/main/0000-template.md), [Server Components RFC](https://github.com/reactjs/rfcs/blob/main/text/0188-server-components.md)

## Kubernetes KEPs

**What it is.** Kubernetes Enhancement Proposal。`kep.yaml` の metadata と `README.md` の本文を持つ。provisional / implementable / implemented / deferred / rejected / withdrawn / replaced の status。

**What it does well.**

- Release Signoff Checklist、Summary、Motivation、Goals、Non-Goals、Proposal、User Stories、Notes/Constraints/Caveats、Risks and Mitigations、Design Details、Test Plan、Graduation Criteria、Upgrade/Downgrade Strategy、Version Skew Strategy、Production Readiness Review Questionnaire、Implementation History、Drawbacks、Alternatives、Infrastructure Needed。
- Test Plan を unit / integration / e2e に分け、graduation criteria を alpha / beta / GA で書く。
- PRR（production readiness review）で、enablement / rollback / rollout / monitoring / dependencies / scalability / troubleshooting を確認する。
- 1 KEP = 1 feature の lifecycle。beta → GA で新しい KEP を作らない。

**Steal.**

- プラットフォーム・インフラ・運用に影響する変更では、test / graduation / rollback / version skew / PRR を独立した節にする。
- metadata を header に置き、status を機械可読にする。
- 1 proposal の lifecycle を1つの文書で追う。

**Don't copy.**

- 小さい product 変更に KEP の全 checklist を要求しない。重さを選ぶ。
- Kubernetes の SIG / approver 制度をそのまま持ち込まない。

Links: [kubernetes/enhancements](https://github.com/kubernetes/enhancements), [KEP template](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/README.md), [kep.yaml](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/kep.yaml)

## Python PEPs

**What it is.** Python Enhancement Proposal。Standards Track / Informational / Process の3種類。PEP 1 が目的・workflow・format、PEP 12 が reStructuredText template。

**What it does well.**

- 1 PEP = 1 key proposal。focused でない PEP は editors が拒否できる。
- champion / sponsor を明示する。sponsor は process の mentor。
- audience を定義する（core developers / Steering Council / community）。
- editor review（sound / complete / title / language / markup）と acceptance（technical / consensus）を分ける。
- 却下理由の例: duplication、technically unsound、motivation / backwards compatibility の不足、Python philosophy と合わない。
- Standards Track は reference implementation / compatibility を重視する。

**Steal.**

- 1文書1提案。
- champion / sponsor / audience を header に置く。
- 編集レビューと技術承認を分ける。
- 却下理由を先に想像して、motivation / compatibility を厚くする。

**Don't copy.**

- PEP の reST 形式や番号制度を、そのまま Markdown の RFC に持ち込まない。必要なのは focus / sponsor / audience / review の分離。

Links: [python/peps](https://github.com/python/peps), [PEP 1](https://github.com/python/peps/blob/main/peps/pep-0001.rst), [PEP 12](https://github.com/python/peps/blob/main/peps/pep-0012.rst)

## Go design docs

**What it is.** Go はまず proposal issue を作り、必要なら design doc を書く。design doc は `design/NNNN-shortname.md`、template は Abstract / Background / Proposal / Rationale / Compatibility / Implementation / Open issues。

**What it does well.**

- **まず issue**。design doc は「もっと丁寧な説明と検討が必要」なときだけ。軽い proposal をいきなり重い文書にしない。
- Rationale で代替案と trade-off を書く。
- Compatibility を独立した節にし、Go 1 compatibility を明示する。
- Implementation で「誰がいつやるか」まで書く。
- 80 columns・1 sentence per line。レビューしやすさを形式に埋め込む。
- design doc shepherd が著者を助ける。

**Steal.**

- proposal issue → design doc の段階。
- Rationale / Compatibility / Implementation / Open issues。
- 1 sentence per line でレビューしやすくする。
- 「実装を誰がいつやるか」を書く。

**Don't copy.**

- Go の 80 columns を絶対視しない。Markdown の長い行が読みやすいなら、レビュー単位で分割する。

Links: [golang/proposal](https://github.com/golang/proposal), [proposal process](https://github.com/golang/proposal/blob/master/README.md), [design template](https://github.com/golang/proposal/blob/master/design/TEMPLATE.md), [type parameters design](https://github.com/golang/proposal/blob/master/design/43651-type-parameters.md)

## Swift Evolution

**What it is.** Swift の言語提案。proposal template は header に Proposal / Authors / Review Manager / Status / Vision / Roadmap / Bug / Implementation / Feature Flags / Previous Proposal / Previous Revision / Review を持つ。

**What it does well.**

- header に status / review manager / implementation / feature flag を集める。
- **Summary of changes は 50 words 以内**。out-of-context で読める。
- Motivation / Proposed solution / Detailed design / Source compatibility / ABI compatibility / Implications on adoption / Alternatives / Future directions。
- Source / ABI compatibility を独立した節にし、既存コードへの影響を具体的に書く。
- Review の history（pitch / review / revision / acceptance / rejection）を header に残す。

**Steal.**

- header に status / owner / implementation / review history。
- 50 words summary。
- source / ABI / adoption を独立した節にする。
- review の履歴を残す。

**Don't copy.**

- 言語の ABI 互換性を、product の互換性にそのまま当てない。抽象化して「何が壊れるか」を書く。

Links: [apple/swift-evolution](https://github.com/apple/swift-evolution), [template](https://github.com/apple/swift-evolution/blob/main/proposal-templates/0000-swift-template.md)

## TC39

**What it is.** ECMAScript の proposal process。Stage 0（strawperson）から Stage 4（standard）まで、entrance criteria が決まっている。

**What it does well.**

- 各 stage の entrance criteria が明確。Stage 1 は problem / shape / cross-cutting concerns、Stage 2 は spec text、Stage 2.7 は reviewers / editor sign-off、Stage 3 は tests / implementations、Stage 4 は 2 implementations + Test262 + field experience。
- champion / champion group が proposal を進める。
- designated reviewer は committee が選び、著者ではない。Stage 2.7 の前に sign-off。
- consensus が取れないときは、なぜ進まなかったかを meeting notes と issue に残す。
- conditional advancement（条件付き前進）で、未解決の条件を issue にする。

**Steal.**

- stage gate（何が揃ったら次に進むか）。
- champion / designated reviewer。
- 実装・テスト・利用実績を根拠にする。
- 合意しなかった理由を残す。
- 条件付き前進（condition + issue）。

**Don't copy.**

- 6 stage をすべての変更に要求しない。変更の重さに合わせて gate を減らす。

Links: [tc39/proposals](https://github.com/tc39/proposals), [process document](https://tc39.es/process-document/)

## IETF RFCs

**What it is.** IETF の標準文書。RFC 7322 が style / structure、RFC 2119 / 8174 が MUST / SHOULD / MAY の規範語。

**What it does well.**

- Abstract / Introduction / Requirement Language / Security Considerations / IANA Considerations / References の構造。
- 規範語を大文字で使い、意味を明確にする。ただし乱用しない。
- Security Considerations を独立した節にし、実装者が見落とさないようにする。
- 参照（normative / informative）を分ける。
- style guide が、読みやすさ・一貫性・略語・引用を規定する。

**Steal.**

- 規範語（MUST / SHOULD / MAY）を、必要なときだけ大文字で使う。
- Security Considerations を独立した節にする。
- normative / informative の参照を分ける。
- 用語・略語・引用の一貫性。

**Don't copy.**

- RFC の boilerplate（Copyright、IANA、Authors' Addresses）を内部文書にコピーしない。
- すべての文に MUST を付けない。規範語は interop / harm の境界に限定する。

Links: [RFC 7322](https://www.rfc-editor.org/rfc/rfc7322.txt), [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.txt), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.txt)

## Google design docs

**What it is.** Google の design doc 文化の解説。Context and scope / Goals and non-goals / design / alternatives / cross-cutting concerns。

**What it does well.**

- design doc の目的を「design issues の早期発見、合意、cross-cutting concerns、組織の記憶」と整理する。
- Context and scope は客観的な事実だけ。requirements doc にしない。
- Goals と non-goals を箇条書き。non-goal は「選ばなかった目標」。
- design は trade-off を書く場所。implementation manual にしない。
- Alternatives considered を重要視する。採用しなかった理由が読者に分かる。
- Cross-cutting concerns（security / privacy / observability）を独立した節にする。
- 10〜20 pages が目安。1〜3 pages の mini design doc も有効。
- 書かない判断: trade-off が無い、solution が obvious、implementation manual になるなら書かない。
- lifecycle: creation / rapid iteration → review → implementation → maintenance。

**Steal.**

- context / goals / non-goals / design / alternatives / cross-cutting の骨格。
- trade-off 中心。implementation manual にしない。
- 長さの目安と mini design doc。
- 書かない判断。
- review の軽量版 / 重量版を選ぶ。

**Don't copy.**

- Google の規模・review 文化を、そのまま小さいチームに持ち込まない。
- cross-cutting の節を、単なる checklist のコピーにしない。この設計でどう影響するかを書く。

Links: [Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/)

## Amazon PR/FAQ

**What it is.** Working Backwards の PR/FAQ。顧客から逆算し、press release と FAQ を先に書く。

**What it does well.**

- **customer problem** から始める。solution の前に、誰のどんな問題かを書く。
- Press release: heading / subheading / summary / problem / solution / customer quote / call to action。
- Customer FAQ と Internal FAQ を分ける。
- Internal FAQ: 市場、経済性、依存、法務、リスク、**top 3 reasons it won't succeed**。
- 「顧客が読んで欲しくなるか」を強制的に考える。

**Steal.**

- 顧客・利用者の言葉で problem を書く。
- press release 形式で、価値を1段落に圧縮する。
- internal FAQ で、反対理由・リスク・依存を先に潰す。
- top reasons it won't succeed を書く。

**Don't copy.**

- 内部技術 RFC に marketing の誇張を持ち込まない。PR/FAQ は product / customer の提案に向く。
- TAM / 収益の話を、技術 RFC に無理に当てない。

Links: [Working Backwards PR/FAQ](https://workingbackwards.com/resources/working-backwards-pr-faq)

## ADRs

**What it is.** Architecture Decision Record。1 decision = 1 short record。Context / Decision / Status / Consequences。

**What it does well.**

- 1つの決定だけを書く。短い。後から読める。
- Context は価値中立に、force（技術・政治・社会・プロジェクト）を書く。
- Decision は能動態で「We will …」。
- Status（proposed / accepted / deprecated / superseded）を持つ。
- Consequences は positive / negative / neutral を全部書く。
- supersede しても古い ADR を消さない。決定の歴史を残す。

**Steal.**

- 1 decision = 1 record。
- Context / Decision / Status / Consequences。
- 反対意見・不採用理由・negative consequences を残す。
- supersede で履歴を保つ。

**Don't copy.**

- ADR を design doc の代わりにしない。ADR は決定、design doc は設計の全体。
- 1つの ADR に複数の決定を詰め込まない。

Links: [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), [adr.github.io](https://adr.github.io/)

## Shape Up pitch

**What it is.** Basecamp の Shape Up の pitch。Problem / Appetite / Solution / Rabbit holes / No-gos。

**What it does well.**

- **Appetite**（時間予算）を先に固定する。時間が先、scope は後。
- Problem は具体的な1つの story。solution の前に problem。
- Solution は fat-marker sketch のように、細部に入りすぎず、しかし具体的に。
- Rabbit holes（踏むと抜けられない穴）を先に列挙する。
- No-gos（今回やらないこと）を明示する。

**Steal.**

- appetite（時間・予算）を design の制約として書く。
- problem を1つの具体的な story で書く。
- rabbit holes / no-gos を先に書く。
- 細部に入りすぎず、decision に必要な解像度で書く。

**Don't copy.**

- すべての RFC に fixed time box を要求しない。探索的な設計では appetite を柔らかくする。
- Shape Up の用語を、そのまま組織に押し付けない。

Links: [Write the Pitch](https://basecamp.com/shapeup/1.5-chapter-06)

## Next.js REVIEW.md

**What it is.** Next.js の PR レビュー用 rubric。severity（escalate / comment / nit）、escalation triggers、rules、verdict。

**What it does well.**

- severity を明確にし、blocking を限定する。
- evidence を要求する。file / line / observation。
- scope を守る。no drive-bys、motivated changes、stated trade-offs。
- 「explain the design」「record subtle knowledge」「no stale docs」など、設計の記録をレビューの対象にする。
- 「default to approval」で、完璧主義に陥らない。

**Steal.**

- severity（blocking / comment / nit）と evidence。
- scope / trade-offs / no drive-bys。
- design の記録（why、subtle knowledge）をレビューする。
- default to approval。blocking は契約が破れるときに限定する。

**Don't copy.**

- Next.js の code review の escalation trigger を、design doc のレビューにそのまま当てない。抽象化して使う。

Links: [REVIEW.md](https://github.com/vercel/next.js/blob/canary/REVIEW.md)

## 横断して繰り返す型

1. **Problem first.** solution の前に、誰のどんな問題かを書く。
2. **One document, one decision.** 複数の決定を混ぜない。
3. **Non-goals are real alternatives.** 選ばなかった目標を書く。
4. **Options and trade-offs.** 最低2案、do nothing、straw man を避ける。
5. **Guide-level → reference-level.** 教える説明と仕様を分ける。
6. **Failure modes and cross-cutting.** happy path の後に、失敗・security・privacy・observability・cost を書く。
7. **Compatibility and migration.** 何が壊れるか、どう移行し、どう戻すか。
8. **Test and graduation.** どう確かめるか、何を成功とみなすか。
9. **Open questions with owners.** TBD に owner / trigger を付ける。
10. **Decision record.** status、owner、date、dissent、supersede を残す。

# 共通の観点

どの変更でも読む。根拠の R ID は [design.md](../design.md)。領域固有は [security.md](security.md) / [persistence.md](persistence.md) / [contracts.md](contracts.md)。

| 観点 | 条件 | 確認 | Ref |
| --- | --- | --- | --- |
| 失敗の形が層で違う | 隣が `Result` なのに throw（逆も）。listener・callback の reject。`Result` を誰も見ない | 分岐が通るか。空 `catch`、`void` の reject、未検査の `.ok` | [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558), [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf) |
| 失敗の型が境界で化ける | 低層の Error が公開の failure 型に写像されない | ディレクトリ読取・権限・巨大ファイルで、tool / HTTP が defect にならないか | [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558), [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) |
| schema と型が現実と合わない | 注釈の無い schema。型より緩い object。両方が不正な組合せを通す | 型に無い組合せが parse を通らないか。判別 union にできるか | [Illegal States](https://fsharpforfunandprofit.com/series/designing-with-types/), [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) |
| docs の主張が実装より強い | 絶対表現（閉じた・必ず・原子・上限なし）。diff がその文書か実装を変えた | 主張を実装と突き合わせ、残る穴は「残る」と書く | [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558), [Least Astonishment](https://www.infoq.com/articles/API-Design-Joshua-Bloch/), [Hyrum's Law](https://www.hyrumslaw.com/) |
| テストが証明になっていない | 修正前でも通る／同じ不変条件の重複／dist を読む | 落ちる実装を言えるか（直した diff は戻す）。SKIP は環境要因か | [Refactoring](https://martinfowler.com/books/refactoring.html) |
| 修正が新しい違反を生む | 直した diff が境界 schema・上限・docs と矛盾 | 危険な値を再度通す | [Refactoring](https://martinfowler.com/books/refactoring.html), [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558) |
| 規則が二重になる | 同じ規則が2箇所（core とパッケージ、契約と実装、テストと runner） | 片方を消せるか | [DRY](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/) |
| 死んだ抽象 | 呼び出し元がテストだけ、export だけ | 製品コードで数える。0 なら消す（安全機構は配線する） | [Yagni](https://martinfowler.com/bliki/Yagni.html), [Go interfaces](https://go.dev/wiki/CodeReviewComments#interfaces) |

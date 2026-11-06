# 設計: 作るか作らないか・抽象化

設計の前に読む。他の領域は [design.md](../design.md) の索引から。
**条件**は「この形を見たら」、**命令**は「どうする」、**補足**は判断の理由と例外、**Ref** は出典（原典か hns の統合判断かは補足に書く）。

## 今必要でない機能を作らない

- **条件**: 将来の利用者・設定・モード・事業者を想像して、機能や分岐を足そうとしている
- **命令**: 今の呼び出し元が2つ未満なら足さない。足すなら、issue に今の利用者を書く
- **補足**: 2つは hns の統合判断（原典の経験則は3回）。将来の予測より、必要になってからの変更を選ぶ
- **Ref**: [Yagni](https://martinfowler.com/bliki/Yagni.html) / [Is Design Dead?](https://martinfowler.com/articles/designDead.html) / [Rule of Three](https://martinfowler.com/books/refactoring.html) / [Wrong Abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction)

## 後から取り返せないものは先に備える

- **条件**: 時刻・ID・監査ログ・版・保存形式など、後から復元できない情報を後回しにしようとしている
- **命令**: 最初のスキーマと API に入れる。入れた理由を decisions に1行残す
- **補足**: 先に備えるのは「取り返せない」ものだけ。秘密は無条件に保存しない（[security.md](security.md)）
- **Ref**: [PAGNIs](https://simonwillison.net/2021/Jul/1/pagnis/) / [YAGNI exceptions](https://lukeplant.me.uk/blog/posts/yagni-exceptions/) / [Last Responsible Moment](https://www.informit.com/store/lean-software-development-an-agile-toolkit-9780321150783)

## 誤った抽象化は戻す

- **条件**: 共通化した後に、条件分岐や例外が増えている。1つの抽象が2つの意味を持ち始めている
- **命令**: 分岐を足す前に、独立した実装に戻す。戻すコストを理由に残さない
- **補足**: 重複は悪ではない。同じ知識の重複だけが悪い（DRY）。戻すのは失敗ではなく設計
- **Ref**: [Wrong Abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction) / [DRY](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/)

## 抽象化と共通化を混ぜない

- **条件**: 2箇所目を見て「共通化しよう」と思っている
- **命令**: 抽象化（型・境界・モジュール）は2つの利用箇所でよい。共通化（同じ処理を1つにする）は3箇所目まで待つ
- **補足**: 抽象化は境界を引く判断、共通化は知識をまとめる判断。前者は早め、後者は遅め
- **Ref**: [Yagni](https://martinfowler.com/bliki/Yagni.html) / [Rule of Three](https://martinfowler.com/books/refactoring.html) / [DRY](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/) / hns（2と3の使い分け）

## 理解に必要な複雑さだけ残す

- **条件**: 説明に3文以上かかる。汎用層が1箇所でしか使われない。設定項目が誰にも使われていない
- **命令**: 消す。必要になったときに、その形で足す
- **補足**: KISS は「短く書く」ではなく「理解に必要な複雑さを増やさない」
- **Ref**: [Simple Design](https://martinfowler.com/bliki/BeckDesignRules.html) / [Evolutionary Design](https://learn.microsoft.com/en-us/archive/msdn-magazine/2009/brownfield/incremental-delivery-through-continuous-design) / [KISS](https://en.wikipedia.org/wiki/KISS_principle)

## 不可逆な判断は直前まで延ばす

- **条件**: 公開 API・保存形式・プロトコル・ディレクトリ構成を今決めようとしている
- **命令**: 決める必要が生じるまで決めない。決めたら decisions に、捨てた選択肢と一緒に書く
- **補足**: 延期してよいのは可逆な判断だけ。取り返せないものは先に決める（上の PAGNI）
- **Ref**: [Last Responsible Moment](https://www.informit.com/store/lean-software-development-an-agile-toolkit-9780321150783) / [Is Design Dead?](https://martinfowler.com/articles/designDead.html)

## 小さく出して、測って直す

- **条件**: 全体を先に設計しようとしている。不確実な部分のため设计中に選択肢を増やしている
- **命令**: 最小の縦切りで出し、動かして測り、次の判断を直す。境界は「直せる形」で決める
- **補足**: 設計は完成させてから守るものではない。直す前提なので、テストと境界を先に置く
- **Ref**: [Continuous Design](https://learn.microsoft.com/en-us/archive/msdn-magazine/2009/brownfield/incremental-delivery-through-continuous-design) / [Refactoring](https://martinfowler.com/books/refactoring.html) / [Simple Design](https://martinfowler.com/bliki/BeckDesignRules.html)

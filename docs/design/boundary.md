# 設計: 境界と責務

モジュールをどう割り、何を隠すかを決めるときに読む。索引は [design.md](../design.md)。

## 変わる設計判断を隠す

- **条件**: 同じ理由で複数のパッケージが変わりそうなとき。利用側が保存形式やプロトコルを知っているとき
- **命令**: その判断を1つのパッケージの内側に置き、公開面には出さない
- **補足**: 隠すのは「実装」ではなく「変わる判断」。何が変わるか言えないなら、まだ境界が決まっていない
- **Ref**: [Information Hiding](https://dl.acm.org/doi/10.1145/361598.361623) / [Encapsulation](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)

## 公開面は必要最小にする

- **条件**: export を足そうとしている。内部型を公開 signature に使おうとしている
- **命令**: 利用者が2つ以上いるものだけ export する。内部型は境界で公開 DTO に変換する
- **補足**: 公開した型は契約になる（Hyrum）。消すコストは足すコストより高い
- **Ref**: [Parnas 1972](https://dl.acm.org/doi/10.1145/361598.361623) / [Effective Java](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/) / [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [Hyrum's Law](https://www.hyrumslaw.com/)

## 依存は一方向にする

- **条件**: 逆方向の import が必要になったとき。下位が上位の型を知る必要が出たとき
- **命令**: 型を core に移すか、境界を引き直す。依存を循環させない
- **補足**: 方針（何を許すか）は詳細（どう保存するか）から独立させる
- **Ref**: [Low Coupling](https://www.pearson.com/en-us/subject-catalog/p/applying-uml-and-patterns-an-introduction-to-object-oriented-analysis-and-design-and-iterative-development/P200000000422/9780131489066) / [DIP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) / [Parnas 1972](https://dl.acm.org/doi/10.1145/361598.361623)

## 責務は変更理由で割る

- **条件**: 1ファイルに複数の変更理由があるとき（保存形式と表示、認可と計算など）
- **命令**: 変更理由ごとに分ける。同じ理由で変わるものは同じ場所に置く
- **補足**: 行数ではなく「誰がなぜ変えるか」で割る。判断は、そのデータを持つ場所に置く（Information Expert）
- **Ref**: [SRP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) / [High Cohesion](https://www.pearson.com/en-us/subject-catalog/p/applying-uml-and-patterns-an-introduction-to-object-oriented-analysis-and-design-and-iterative-development/P200000000422/9780131489066) / [Separation of Concerns](https://www.cs.utexas.edu/~EWD/transcriptions/EWD04xx/EWD447.html) / [GRASP](https://www.pearson.com/en-us/subject-catalog/p/applying-uml-and-patterns-an-introduction-to-object-oriented-analysis-and-design-and-iterative-development/P200000000422/9780131489066)

## 深いモジュールにする

- **条件**: 呼び出し側が手順を3つ以上並べているとき。同じ前後処理を各所で書いているとき
- **命令**: 1つの関数にまとめ、失敗は値で返す。利用側からは1回の呼び出しにする
- **補足**: 小さいインターフェースで大きい複雑さを隠す。引数と戻り値の数が目安
- **Ref**: [Deep Modules](https://web.stanford.edu/~ouster/cgi-bin/book.php) / [Abstract Data Types](https://dl.acm.org/doi/10.1145/800233.807045)

## 継承より合成を使う

- **条件**: 差分だけ変えるために継承を足そうとしている。基底クラスが状態を持つ
- **命令**: 関数・注入・合成にする
- **補足**: 継承は「is-a」が本当に成り立つときだけ。拡張点は必要になってから
- **Ref**: [Composition over Inheritance](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)

## パターンは必要になってから入れる

- **条件**: 実装前に GoF パターン名を決めている。将来の差し替えのために層を足している
- **命令**: 2つ目の実例が出るまで入れない。入れるなら、何が楽になったかを1行書く
- **補足**: パターンは既知の問題への解決策であって、設計の目標ではない
- **Ref**: [GoF](https://www.informit.com/store/design-patterns-elements-of-reusable-object-oriented-9780201633610) / [Yagni](https://martinfowler.com/bliki/Yagni.html) / [Wrong Abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction)

## 内部を深く辿らない

- **条件**: `a.b.c.d` で状態を読んでいるとき。他のモジュールの内部配列を直接触っているとき
- **命令**: 所有者に問い合わせる（メソッドを足す）。公開モデルには内部を入れない
- **補足**: 辿るたびに、その内部構造が契約になる
- **Ref**: [Law of Demeter](https://dl.acm.org/doi/10.1145/62084.62113) / [Effective Java](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)

## interface を増やさない

- **条件**: 実装が1つしかないのに interface を切ろうとしている。SOLID のために抽象を足している
- **命令**: 具象型で書く。2つ目の実装か、テストで差し替える必要が出たら切る
- **補足**: 利用側が欲しい形で切る（Go の流儀）。先に interface を置かない
- **Ref**: [Go interfaces](https://go.dev/wiki/CodeReviewComments#interfaces) / [Yagni](https://martinfowler.com/bliki/Yagni.html) / [ISP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html)

## 可変性を外に出さない

- **条件**: 配列・Map・オブジェクトを返すとき、または受け取って保持するとき
- **命令**: コピーか readonly を返す。内部状態を参照で渡さない。外から書き換えられる前提を作らない
- **補足**: 呼び出し側の書き換えで不変条件が壊れる。コストが問題なら、その時点で測る
- **Ref**: [Effective Java 15–17](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/) / [Abstract Data Types](https://dl.acm.org/doi/10.1145/800233.807045)

## 拡張点は3種類目で切る

- **条件**: 新しい種類を足すたびに、既存の switch や if を直しているとき
- **命令**: 1〜2種は分岐でよい。3種目で拡張点（判別 union か関数の注入）を切る
- **補足**: OCP のために先に interface を置かない。拡張点は「変更が痛くなってから」
- **Ref**: [OCP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) / [SRP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) / [Yagni](https://martinfowler.com/bliki/Yagni.html)

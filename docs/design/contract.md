# 設計: 型と契約

公開する型・関数・エラーを決めるときに読む。索引は [design.md](../design.md)。

## 境界で parse する

- **条件**: HTTP の body・query・path params、DB の行、環境変数、JSON、モデルの出力が入ってくる
- **命令**: 境界で valibot に通し、以降は型を信じる。検証済みの値をそのまま持ち回る
- **補足**: 内部で「念のため」再検証しない。二重の規則は片方だけ直る
- **Ref**: [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) / [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558)

## 不正な状態を型で作れなくする

- **条件**: 「A のときだけ B」「role によって必須項目が変わる」を if で守っている
- **命令**: 判別 union にする。無いことを表すなら `null` と `undefined` を混ぜず、型で1つに決める
- **補足**: if を減らせないなら、まだ型が足りない。brand は取り違えが起きるときだけ
- **Ref**: [Illegal States Unrepresentable](https://fsharpforfunandprofit.com/series/designing-with-types/) / [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558)

## 想定内の失敗は型で返す

- **条件**: 拒否・競合・不在・上限など、利用者が直せる失敗がある
- **命令**: `Result` か `ErrorCode` で返す。例外は defect（バグ）だけにする
- **補足**: 1つの拒否で run を落とさない。呼び出し側が分岐できる形にする
- **Ref**: [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558) / [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf) / [Command-Query Separation](https://martinfowler.com/bliki/CommandQuerySeparation.html)

## 前提が崩れたら、その場で止める

- **条件**: 契約違反のまま処理を続けている。失敗を握って既定値で進めている
- **命令**: その場で throw するか拒否する。fallback で隠さない
- **補足**: 起動時の検査は fail closed。できない検査は拒否として扱う
- **Ref**: [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf)

## 名前は振る舞いを予測させる

- **条件**: 名前を読んでも副作用・失敗・単位が分からない。驚く挙動がある
- **命令**: 動詞＋対象にする。副作用は名前に出す。単位は名前に含める（`Ms` / `Bytes`）
- **補足**: 名前と挙動がずれたら、doc ではなく名前に戻す
- **Ref**: [Least Astonishment](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [Bumper-Sticker API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/)

## 引数は少なく、型で区別する

- **条件**: boolean 引数が並ぶ。同じ型の引数が2つ以上続く。オプションが増えている
- **命令**: 名前付きの型にする。boolean は別関数か判別 union にする
- **補足**: 呼び出し側を読んで意味が分かるか。誤用しにくさは型で作る
- **Ref**: [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines) / [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)

## 1つの関数に1つの用途を持たせる

- **条件**: 公開関数が増える。同じことをする入口が複数ある。1つの関数にモードが増えている
- **命令**: 用途ごとに1つにする。モードは別関数か判別 union にする。内部実装を signature に出さない
- **補足**: 公開した時点で互換の制約が付く（Hyrum）。公開面そのものの大きさは [boundary.md](boundary.md) で決める
- **Ref**: [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) / [Hyrum's Law](https://www.hyrumslaw.com/)

## 問い合わせと変更を分ける

- **条件**: 読み取りのつもりで状態が変わる。GET で副作用がある
- **命令**: 問い合わせは変更しない。変更は明示的なコマンドにする
- **補足**: 分けると、リトライ・キャッシュ・権限が単純になる
- **Ref**: [Command-Query Separation](https://martinfowler.com/bliki/CommandQuerySeparation.html)

## 互換を壊すなら、先に宣言する

- **条件**: 公開 signature・wire のキー・イベント名・ファイル API の意味が変わる
- **命令**: 移行経路を用意するか、decisions に破壊的変更として書く。利用者を列挙する
- **補足**: 「誰も使っていないはず」を根拠にしない。PoC・保存済み DB・Journal も利用者
- **Ref**: [Hyrum's Law](https://www.hyrumslaw.com/) / [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) / [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/)

## 差し替えても呼び出し側が変わらない

- **条件**: 実装を差し替える。2つ目の実装を足す。保存先や transport を替える
- **命令**: 事前条件を強めず、事後条件を弱めない。呼び出し側に分岐が増えるなら、契約が足りない
- **補足**: LSP は型の話ではなく振る舞いの話。同じ入力で同じ意味の結果を返す
- **Ref**: [Liskov & Wing 1994](https://dl.acm.org/doi/10.1145/197320.197383) / [LSP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) / [DIP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html)

## 所有権と寿命を決める

- **条件**: バッファ・fd・プロセス・接続・ストリームを渡す、または保持する
- **命令**: 誰が閉じるかを API で決める。破棄後に触れる参照を返さない。失敗時にも解放される形にする
- **補足**: 所有者が曖昧なまま動くコードは、二重解放かリークのどちらかになる
- **Ref**: [C++ Core Guidelines（Resource management）](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines) / [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)

## 非同期の完了・失敗・キャンセルを分ける

- **条件**: 待つ処理がある。中断・タイムアウト・再試行がありうる
- **命令**: 完了・失敗・キャンセルを型で分ける。キャンセル後の状態を決める。中断を「失敗」に混ぜない
- **補足**: 呼び出し側が「まだ動いている」と「終わった」を区別できるようにする
- **Ref**: [C++ Core Guidelines（Concurrency）](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines) / [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) / [Go interfaces](https://go.dev/wiki/CodeReviewComments#interfaces)

## 不変条件を書く

- **条件**: 型だけでは守れない前提がある（単調増加、合計、排他、版の一致）
- **命令**: JSDoc とテストに書き、破る操作を作らない。実行時に守るなら境界に検査を置く
- **補足**: 書かれていない不変条件は、レビューでもテストでも守れない
- **Ref**: [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558) / [Illegal States](https://fsharpforfunandprofit.com/series/designing-with-types/)

## 公開契約をドキュメントに書く

- **条件**: 公開 API・コマンド・ルートを足す
- **命令**: 前提・失敗・保証・例を書く。例はテストにする
- **補足**: 型で言えないこと（順序、冪等、上限、失敗後の状態）を書く
- **Ref**: [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558) / [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)

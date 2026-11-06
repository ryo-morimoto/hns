# 設計: 状態・永続化・並行

状態を持つもの、保存するもの、同時に走るものを設計するときに読む。索引は [design.md](../design.md)。

## 再送しても二重に適用しない

- **条件**: クライアントやモデルが同じ操作を2回送りうる。処理が途中で落ちうる
- **命令**: 操作キーで outcome を記録する。同キー・同内容は記録済みを返し、同キー・別内容は拒否する
- **補足**: 記録を持つ期間を決め、超えた再送の意味を docs に書く
- **Ref**: [RFC 9110（idempotent）](https://www.rfc-editor.org/rfc/rfc9110) / [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558)

## 置き換えは原子的に、保存は直列に

- **条件**: ファイルや状態を丸ごと置き換える。保存が同時に走りうる
- **命令**: temp に書いて rename する。保存を1本のキューに直列化する。途中で落として再オープンを試す
- **補足**: 「ほとんど原子的」は原子性ではない。壊れたときの復旧を設計に入れる
- **Ref**: [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558) / [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)

## 競合は版で検出する

- **条件**: 同じ対象を2人が同時に更新しうる。後勝ちで消えると困る
- **命令**: 期待版を入力に取り、違えば conflict を返す。版を持たない更新を作らない
- **補足**: 版は公開型に入れる。競合は失敗として返し、黙って上書きしない
- **Ref**: [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558) / [Hyrum's Law](https://www.hyrumslaw.com/)

## 上限と単位を決める

- **条件**: 配列・ログ・戻り値・保持件数が伸び続ける。外部に返す量が入力で決まる
- **命令**: 上限を決め、超えたら落とす。単位は byte（JSON 化後）で数える
- **補足**: 上限が無いなら「無い」と docs に書く。設定可能な上限は 0・負・超過も試す
- **Ref**: [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [Leaky Abstractions](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/) / [AIP-158](https://google.aip.dev/158)

## 移行を戻せるようにする

- **条件**: 保存形式を変える（列の追加・削除、backfill、user_version、破壊的 ALTER）
- **命令**: 古い DB で移行を試す。途中で落として再開できるか確かめる。戻し方を書く
- **補足**: 保存形式は観測可能な契約。変えるなら破壊的変更として扱う
- **Ref**: [Hyrum's Law](https://www.hyrumslaw.com/) / [Last Responsible Moment](https://www.informit.com/store/lean-software-development-an-agile-toolkit-9780321150783)

## 下位の性質は隠しきれない

- **条件**: 抽象化が性能・順序・上限・失敗の確率を隠している
- **命令**: 計算量と上限を公開する。隠せない性質を docs に書く
- **補足**: 漏れることを前提に、境界と上限を設計する
- **Ref**: [Leaky Abstractions](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/)

## 状態遷移を1箇所に置く

- **条件**: status を持つ。状態によって許される操作が変わる
- **命令**: 遷移表を1箇所に置き、不正遷移を型か実行時で拒否する。各所の if に散らさない
- **補足**: 遷移の正本はコード1箇所。docs とテストはそこから作る
- **Ref**: [Illegal States](https://fsharpforfunandprofit.com/series/designing-with-types/) / [SRP](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) / [GRASP](https://www.pearson.com/en-us/subject-catalog/p/applying-uml-and-patterns-an-introduction-to-object-oriented-analysis-and-design-and-iterative-development/P200000000422/9780131489066)

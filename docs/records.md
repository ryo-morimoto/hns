# 仕事の記録（WorkRecord）

2026-11-16 / D067・D071。実装は @hns/record（packages/record）。

## 目的

完了を Result の追記ではなく、検証できる記録で表す。レビュー・進捗・次セッションが同じ記録を読み、判断を使い回せるようにする。

## 置き場

1 issue 1 レコード。work/records/NNNN.yaml。YAML 1.2。

~~~
npm run record -- init 0196
npm run record -- check
npm run record -- list
npm run record -- show 0195
~~~

## 形

| 欄 | 内容 |
| --- | --- |
| schema | 1 固定。形を変えるときは版を上げる |
| issue | 4桁の issue 番号 |
| intent | 誰のどの課題を、なぜ今か |
| criteria | 受入基準。id / kind / status / evidence / note |
| limits | この証拠が保証しないこと。1件以上 |
| decision | by / at / basis。誰がいつ何をもって受け入れたか |
| invalidation | 何が変わったら無効か。1件以上 |
| integration | 変更が動いた場所（commit / deploy / demo）。任意 |
| outcome | 外部の観測値（source / ref / observed_at / confidence）。任意 |
| learning | 学びを書いた場所（rule / test / eval / decision）。任意 |

criteria の status は unchecked / passed / failed / waived。passed には evidence、waived には note が要る。未知キーは拒否する。

## done level

記録から導出する。手で書かない。

| レベル | 条件 |
| --- | --- |
| learned | learning がある |
| observed | outcome がある |
| integrated | integration がある |
| verified | criteria が全て passed か waived |
| intended | intent がある |
| generated | それ以外 |

順序は learned > observed > integrated > verified > intended > generated。ただし前提を飛ばさない。criteria に failed や unchecked が残る限り、integration や outcome があっても level は intended で止まる。

## 消費者

| 消費者 | 何に使う |
| --- | --- |
| レビュー | criteria のカバレッジと limits |
| 進捗 | 証拠カバレッジ、done level、停滞 |
| 次セッション | intent、decision、invalidation |
| 製品 | 0197 で WorkItem / Evidence に写像 |

## 移行

新規の issue から使う。過去の issue は遡及しない（D067）。形式を変えるときは schema の版を上げ、古いレコードはその版のまま読む。

## 参照

- [0195](../work/issues/0195-work-record-contract.md)
- [0196](../work/issues/0196-record-package.md)
- [packages/record/README.md](../packages/record/README.md)

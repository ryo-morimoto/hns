# @hns/record

仕事の記録（WorkRecord）の schema、done level の導出、YAML 入出力、CLI。

## 使い方

```
npm run record -- init 0196
npm run record -- check
npm run record -- list
npm run record -- show 0195
```

記録は work/records/NNNN.yaml に置く。

## 不変条件

- schema は 1 固定。形を変えるときは版を上げる。
- passed には evidence、waived には note が要る。
- limits と invalidation は1件以上。
- done level は導出する（learning > outcome > integration > verified > intended > generated）。criteria が未解決なら、integration や outcome があっても intended で止まる。
- 記録に done level を書かない。
- workRecordSchema は形だけを見る。passed の evidence と waived の note は validateRecord（parseRecordText 経由）が見る。

## 開発

```
npm test -w @hns/record
npm run build -w @hns/record
```

設計は [0196](../../work/issues/0196-record-package.md)、決定は D067 と D071。

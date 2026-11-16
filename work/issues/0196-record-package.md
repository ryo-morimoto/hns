# 0196: 構造化レコードの実装（@hns/record・YAML・CLI）

status: done
priority: now
depends-on: 0195
touches: packages/record/, package.json, package-lock.json, vitest.config.ts, docs/packages.md, work/records/, work/BOARD.md, work/issues/

## Intent

完了の記録がレビュー・進捗・次セッションに使われていない（[0195](0195-work-record-contract.md)）。記録を型・スキーマ・導出・YAML・CLI として実装し、まず hns の開発で使えるようにする。製品統合は [0197](0197-record-product-integration.md)。

## Goal

@hns/record を作り、work/records/NNNN.yaml を検証・一覧・表示できる CLI を提供する。

## Acceptance criteria

- [x] @hns/record が型、schema、done level の導出、YAML 入出力を公開する
- [x] CLI が init / check / list / show を提供する（npm run record -- ...）
- [x] 不正なレコードを丸めずに拒否する（issue id、criteria の重複、limits、invalidation、waived の根拠、outcome の形）
- [x] work/records/0195.yaml と 0196.yaml が check を通る
- [x] unit テスト（schema / derive / io / cli）、typecheck、build が通る
- [x] npm run check が通る
- [x] 独立レビュー PASS
- [x] docs/packages.md、README、CHANGELOG を更新

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 正しいレコード → parse → 型と done level が返る | 中 | 受入1 |
| C2 | criteria の id 重複 → parse → 拒否 | 中 | 受入3 |
| C3 | waived で note 無し → parse → 拒否 | 中 | 受入3 |
| C4 | outcome の source が未知 → parse → 拒否 | 低 | 受入3 |
| C5 | YAML → format → parse → 同じ内容 | 中 | 受入1 |
| C6 | 不正ファイル → check → 非0で終了し、理由を出す | 高 | 受入2・3 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C4 | 境界値・同値分割 | unit | packages/record/src/schema.test.ts |
| T2 | C5 | 往復 | unit | packages/record/src/record-io.test.ts |
| T3 | C6 | 故障注入 | unit | packages/record/src/cli.test.ts（run に注入） |
| T4 | 受入5 | ゲート | static / build | npm run check |

## Notes

- 依存は core、valibot（^1.5.0）、yaml（exact pin）。YAML は YAML 1.2。
- 導出は記録の事実だけから行う。手動 level は持たない。
- CLI は Node 26 の型ストリップでソースから動かし、bin は dist を指す。
- 製品統合は 0197。D1 / GraphQL / UI はここで作らない。

## 未確定

| ID | 何が | 仮説 | 影響 | トリガー |
| --- | --- | --- | --- | --- |
| U-30 | レコードの schema 版 | v1 固定 | 移行 | 形式を変えるとき |
| U-31 | 製品側 JSON との写像 | 0197 で決める | 二重定義 | 0197 |

## やらないこと

- D1 / GraphQL / UI（0197）
- 既存 issue の遡及移行
- outcome の取得（OutcomeSource）

## Log

- 2026-11-16: 作成。0195 の J1 に沿って、YAML レコードと CLI を先に作る。
- 2026-11-16: @hns/record を実装。15 tests、typecheck、build、npm run check が通過。独立レビュー中。
- 2026-11-16: 独立レビュー 1回目 FAIL（空白のみの必須テキスト、issue とファイル名の不一致）。trim 判定、kind=read/invalid、ファイル名照合を追加し、20 tests に増やした。
- 2026-11-16: 再レビュー PASS（blocking 0）。記録 [0196.yaml](../records/0196.yaml)（verified）。

## Result

- 実装: @hns/record 0.1.0（types / schema / derive / record-io / cli）。work/records/NNNN.yaml を検証・一覧・表示する。
- 文書: [docs/records.md](../../docs/records.md)、D071、[docs/packages.md](../../docs/packages.md)。
- 検証: 20 tests、typecheck、build、npm run check（lint / fmt / typecheck / test / build / deploy / knip）が ok。
- 独立レビュー: record-reviewer / **PASS** / HEAD 04d6bc9 + 作業ツリー。1回目 FAIL の2件（空白のみ、ファイル名不一致）を修正し、再レビューで解消を確認。
- 記録: [work/records/0196.yaml](../records/0196.yaml)（verified、4/4）。
- 残件: 製品統合は [0197](0197-record-product-integration.md)。runInit の write 失敗、check の --dir と positional の併用は未処理（低）。

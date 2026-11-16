# 0195: 仕事の記録の契約（意図・方針・判断）

status: done
priority: now
depends-on: —
touches: docs/decisions.md, docs/domain.md, work/issues/, work/BOARD.md

## Goal

「仕事の記録」を、読むだけでなくレビュー・進捗・次回の判断に使える形にする。
Result への追記では届かないため、構造化レコードと消費者を決め、外部のインフラ・顧客メトリクスとの境界を決める。
この issue は意図・方針・判断だけを持つ。実装は子 issue に分け、別セッションで着手する。

## Intent

- いま Result は書かれているが、レビューで使われず、進捗にも次回の判断にも使われていない。
- 記録が判断に使われないと、完了は L3（統合され動く）で止まり、長期のループが蓄積しない。
- 対象は hns を開発する人間と agent。将来は hns を仕事の記録に使う利用者。

## 方針（採用）

1. 記録は prose ではなく、スキーマを持つ構造化データにする。
2. 記録は消費者とセットで設計する。消費者はレビュー、進捗、次回セッション、製品 UI の4つ。
3. done level は記録から導出する。手動で上げる API を作らない。
4. hns は外部システムの正本を持たない。参照・観測値・判定だけを持つ。
5. インフラ・顧客メトリクスは read-only の OutcomeSource で接続する。
6. 既定は軽い。すべての作業に完全な記録を要求しない。

## 重要な判断（決定）

| ID | 決めること | 決定 | 決め方 |
| --- | --- | --- | --- |
| J1 | レコードの置き場とスキーマ | 決定: work/records/NNNN.yaml、YAML、@hns/record が検証（schema v1） | 決定（D067） |
| J2 | 消費者の実装順 | 決定: レビュー（check）→ 進捗（list）→ 次セッション（show）→ 製品 UI（0197） | 決定 |
| J3 | 最初の OutcomeSource | 決定: デプロイ / CI。実装は 0198 候補 | 決定 |
| J4 | 既存 issue の移行 | 決定: 遡及しない。0195 以降の新規から | 決定 |

## 記録の最小スキーマ（案）

~~~yaml
issue: "0195"
intent: "Result を、レビューと次の判断に使える記録にする"
done_level: L3
criteria:
  - id: C1
    kind: test
    status: passed
    evidence: "npm run check"
limits: ["性能は未検証"]
decision:
  by: user
  at: "2026-11-16"
  basis: "受入条件と証拠を確認"
invalidation: ["API 契約の変更", "OutcomeSource の仕様変更"]
outcome:
  source: deploy
  ref: "deploy/2026-11-16"
  observed_at: "2026-11-16T10:00:00Z"
  note: "本番反映を確認"
~~~

### 消費者

| 消費者 | 何に使う | どこ |
| --- | --- | --- |
| reviewer | criteria のカバレッジと limits を見る | レビュー |
| lead | 証拠カバレッジ、停滞、done level | BOARD / 週次 |
| 次セッション | 意図・判断・無効条件を読む | issue 冒頭のリンク |
| 製品 | import / export、GraphQL | 後続 issue |

**消費者がいない欄は作らない。** 使われない記録は、書かれない記録よりも悪い。

## ループの境界

- hns が持つ: 意図、受入基準、証拠の参照、限界、判断、無効化。
- 外部が持つ: デプロイ / インフラ、プロダクト分析、顧客の声、課金。
- 接続は read-only。生データを複製しない。観測値・時刻・出所・信頼度だけを持つ。
- ループは intent → change → evidence → deploy → outcome → decision → next intent。
- 取得できないときは unknown。成功に丸めない。

## Acceptance criteria

- [x] J1〜J4 が決まり、decisions に追記される
- [x] 記録のスキーマと消費者の一覧が docs に置かれる（docs/records.md）
- [x] 0195 自身のレコードが1件、実例として存在する（work/records/0195.yaml）
- [x] 子 issue（レコード、レビュー、OutcomeSource）が切られる（0196 / 0197）
- [x] BOARD と issue の priority が一致している

## Notes

- 背景は [work/proposals/](../proposals/) の2案。ただし提案は仕様ではない。
- [0116](0116-model-work-item.md)（WorkItem）と [0120](0120-data-review-evidence.md)（Evidence）を土台にする。実装の子 issue は両方に依存する。
- 記録は issue の外に出してもよいが、issue から辿れることを必須にする。
- テスト条件は実装の子 issue で書く。この issue は設計のみ。

## 未確定

| ID | 何が | 仮説 | 影響 | トリガー |
| --- | --- | --- | --- | --- |
| U-26 | レコードの置き場とスキーマ | YAML sidecar | 検証・検索のしやすさ | J1 |
| U-27 | 最初の OutcomeSource | デプロイ / CI | ループが閉じるか | J3 |
| U-28 | 既存 issue の移行 | 遡及しない | 過去の比較 | J4 |
| U-29 | 秘密と認可 | 既存の秘密基盤を使う | 外部接続の安全性 | J3 |

## やらないこと

- 実装（別セッション。子 issue で行う）
- BI / メトリクス基盤の再実装
- すべての issue への記録の強制
- 過去 issue の遡及移行

## Log

- 2026-11-16: 提案2案のレビューを受けて作成。Result が使われていないこと、製品だけに閉じないことを方針に反映。実装は別セッション。
- 2026-11-16: 採用。D067〜D070 を decisions に追記。J1〜J4 は別セッションで決める。
- 2026-11-16: J1〜J4 を決定。実装は [0196](0196-record-package.md)、製品統合は [0197](0197-record-product-integration.md)。

## Result

- 決定: J1（work/records/NNNN.yaml、YAML、@hns/record が検証）、J2（check → list → show → 製品 UI）、J3（最初の OutcomeSource はデプロイ / CI）、J4（遡及しない）。
- 文書: [docs/records.md](../../docs/records.md)、D067〜D071。
- 実装: [0196](0196-record-package.md) で @hns/record。記録: [work/records/0195.yaml](../records/0195.yaml)（learned）。
- 製品統合は [0197](0197-record-product-integration.md)。
- レビュー: 実装を含む 0196 の独立レビューで確認する（この issue は設計と記録のみ）。

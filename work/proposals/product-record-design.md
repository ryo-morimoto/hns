# hns の製品設計：「仕事の記録」を核にする（案）

2026-11-16 / 採用（D067・D070）。対象は hns の製品モデル、契約、画面。
背景は [AI時代のプロダクトマネジメント](../research/ai_era_product_management.md)、既存の画面原則は [interface.md](../../docs/design/interface.md)、
既存 issue は [0116](../issues/0116-model-work-item.md) と [0120](../issues/0120-data-review-evidence.md)。

> **結論：hns の差別化は「チャット」でも「モデル接続」でもない。エージェントの仕事を、意図・受入基準・証拠・限界・決定・無効化つきで記録し、再開・監査・判断できること。** これは研究の Moat（ワークフロー × 独自データ × 信頼）に一致する。製品設計はこの記録を深くする。

## 1. なぜこの核か

機能・UI・モデル接続は短期間で模倣される。a16z の David Haber は「AI は製品差別化の並外れたエンジンだが、Moat ではない」と言う。堀は、ワークフローを端から端まで握る、顧客システムに深く埋め込む、システム・オブ・レコードになる、時間をかけて信頼を獲得することから生まれる。

hns が蓄積できるのは、**仕事の文脈**だ。誰が何を意図し、何を根拠に受け入れ、何を捨て、何が起きたら取り消すか。これは顧客が乗り換えると失うもので、モデルを差し替えても残る。

このループを長期間回し続けられることが、模倣しにくい強みになる。単発の生成品質ではなく、判断の蓄積が効く。だから製品の核は「作る場所」ではなく「記録と判断の層」に置く。

ただし、このループは hns だけで閉じない。デプロイと障害はインフラ、利用と継続はプロダクト分析、声はサポート、収益は課金にある。hns が持つのは**判断と記録**で、観測値そのものではない。境界を決めずに閉じようとすると、BI の再実装になる。

interface.md はすでに「証拠が無い完了は完了と呼ばない」「Needs you → Running → Completed」を掲げている。足りないのは理念ではなく、**それを支えるモデルと契約**である。

## 2. 現状と gap

| 既存 | 状態 | 足りないこと |
| --- | --- | --- |
| [WorkItem（0116）](../issues/0116-model-work-item.md) | task / run / conversation を束ねる。status は表示用の射影 | 完了レベル、受入基準、決定 |
| [Evidence（0120）](../issues/0120-data-review-evidence.md) | 変更ファイル・コマンド・成果物を bounded に返す | 基準との対応、限界、無効化条件 |
| interface 1〜7 | 仕事を主役に、Needs you、レビュー面、直接編集 | レビューの層、決定の種類、テーゼ |
| Task / Run / Conversation | 状態と履歴はある | 「なぜ」と「どこまで保証するか」 |
| 外部の成果（デプロイ・分析・顧客の声） | 接続がない | ループが閉じない。参照する仕組みがない |

## 3. 追加するモデル（最小）

原則は3つ。**既存の正本を二重化しない。完了レベルは導出する。証拠は bounded に保つ。**

### 3.1 AcceptanceCriterion（受入基準）

| 属性 | 内容 |
| --- | --- |
| id | 基準の id |
| work_item_id | 所属する仕事 |
| statement | 検証できる形の文 |
| kind | test / eval / demo / manual |
| status | unchecked / passed / failed / waived |
| waived_by | waiver を認めた Decision の id（任意） |

waived は Decision がないと作れない。口頭の「今回はいい」を状態にしない。

### 3.2 Evidence（証拠）

| 属性 | 内容 |
| --- | --- |
| id | 証拠の id |
| work_item_id | 所属する仕事 |
| covers | どの criterion を満たすか（id の配列） |
| refs | 変更ファイル・コマンド・成果物への参照（bounded） |
| limits | この証拠が保証しないこと（必須） |
| captured_at | 取得時刻 |
| invalidates_on | 何が変わったら無効か |
| outcome | 外部の観測値（source / ref / observed_at / confidence） |

0120 のレスポンスを拡張する。別系統の API を作らない。本文・秘密・認証ヘッダを含めない制約はそのまま継承する。outcome は Evidence の一部だが、**正本は外部にある**。hns は参照と観測値だけを持ち、生データを複製しない。

### 3.3 Decision（決定）

| 属性 | 内容 |
| --- | --- |
| id | 決定の id |
| work_item_id | 対象の仕事（プロジェクト全体なら charter 側） |
| question | 何を決めたか |
| options | 検討した選択肢 |
| choice | 選んだもの |
| rationale | 理由 |
| decided_by / decided_at | 誰がいつ |
| invalidates_on | 前提が変わって無効になる条件 |

decisions.md の D エントリと同じ形にする。**捨てた案と無効条件を書く**のが本体で、結論は1行でよい。

### 3.4 DoneLevel（完了レベル、導出）

generated < intended < verified < integrated < observed < learned

| レベル | 意味 | 導出の条件（案） |
| --- | --- | --- |
| generated | 成果物がある | WorkItem が作られた |
| intended | 意図が合意された | Intent が承認された |
| verified | 受入基準を満たす | criteria が全て passed か waived |
| integrated | 統合され、動く | プレビュー / デモ / 本番の証拠がある |
| observed | 成果が観測された | 指標か顧客行動の証拠がある |
| learned | 学びが蓄積された | 判断ログか Rule / Eval が更新された |

**手で設定する API を作らない。** 保存するならキャッシュと明記し、正本にしない。UI は「次に何をすれば上がるか」を出す。

探索と納品で合格ラインを変える。探索の仕事は verified 相当（ユーザー証拠）で閉じてよく、納品の仕事は integrated を必須にする。

### 3.5 ReviewRequest（レビュー依頼）

| 属性 | 内容 |
| --- | --- |
| id | 依頼の id |
| work_item_id | 対象 |
| layer | intent / design / implementation / outcome |
| risk | low / medium / high |
| assignee | 誰が見るか |
| verdict | pending / pass / fail / blocked |
| findings | 指摘（重大度・場所・観測・修正案） |

既存の PASS / FAIL は implementation 層の規程として残す。Needs you は「承認」ではなく「**どの層の何を決めれば進むか**」を出す。

### 3.6 ProjectCharter（プロダクト・テーゼ）

who / what / why_us / accumulates / not の1枚。レビュー画面に常時表示し、意図レビューの基準にする。四半期に更新し、変更は Decision として残す。

これは「強みを見失わない」ための製品機能である。目の前の変更がテーゼとどう関係するかを、レビューのたびに思い出せる。

### 3.7 Rule（判断の蒸留）

| 属性 | 内容 |
| --- | --- |
| id | ルールの id |
| project_id | 所属 |
| statement | ルール本文 |
| source | 元になったレビュー指摘の id |
| scope | 適用範囲（パス・種類） |
| created_at | 作成時刻 |

レビューで繰り返した指摘をルール化し、エージェントに渡す（AGENTS.md へ export）。効果は「同じ指摘の再発数」で見る。件数（ルール数）を成果にしない。

### 3.8 OutcomeSource（外部との接続）

| 属性 | 内容 |
| --- | --- |
| kind | deploy / infra / analytics / support / billing |
| project_id | 所属 |
| connector | 接続方法（webhook / query / export） |
| auth_ref | 秘密の参照（本文は持たない） |
| mapping | どの WorkItem / criterion に紐づくか |
| freshness | 最終取得と再取得の周期 |

- read-only。hns から外部を変更しない。
- 生データを複製しない。観測値、時刻、出所、信頼度だけを持つ。
- 取得できないときは unknown。成功に丸めない。
- 最初の1つはデプロイ / CI（0195 の J3）。

これでループが閉じる。intent → change → evidence → deploy → outcome → decision → next intent。hns は各段の**判断と記録**を持ち、観測は外部に委ねる。

## 4. 所有と不変条件

| データ | 正本 | 備考 |
| --- | --- | --- |
| WorkItem / Criteria / Decision / Rule / Charter | D1 | 定義と台帳。実行中の状態を置かない |
| Run / 実行中 | DO | 既存どおり |
| Evidence の判定（covers / limits / invalidates_on） | D1 | refs は 0120 が journal / 版から都度導出し、D1 に複製しない |
| OutcomeSource と観測値の参照 | D1 | 生データは外部。hns は参照と観測値だけを持つ |
| WorkItem.status | 元の status の射影 | 0116 の制約を維持 |
| done_level | 導出 | 保存するならキャッシュ |

不変条件の追加候補（番号は仮）：

- **INV-12**: done_level は criteria と evidence から導出され、手動で上げられない。
- **INV-13**: waived の criterion には Decision が必要。
- **INV-14**: Evidence は bounded で、秘密・本文を含まない。
- **INV-15**: Decision は削除しない。訂正は新しい Decision で行い、古いものは無効化する。

## 5. 契約

### GraphQL

WorkItem に doneLevel、criteria、decisions、evidenceSummary を足す。Mutation は recordCriterionResult、recordDecision、requestReview、waiveCriterion。OutcomeSource は outcomeSources で読み、recordOutcome で参照と観測値を取り込む。型は packages/core/src/types.ts が正本で、SDL は生成する（D055）。

### イベント（追記のみ）

work_item.criterion.verified、work_item.done_level.changed、work_item.decision.recorded、work_item.review.requested。EVENT_NAMES は保存済みの文字列なので、既存名を再利用せず追加する。

### REST

0120 の evidence は REST のまま（バイト列と bounded 応答）。GraphQL は要約と参照だけを返す。graph の形をしていない面を GraphQL に載せない方針（D055）を守る。

## 6. 画面

### Progress

状態（Needs you / Running / Completed）の中を done level で並べる。Completed の中に「L3 で止まっている仕事」が見えることが重要だ。完了の錯覚を減らす。

### Needs you

「承認」ではなく「何を決めるか」を出す。意図の承認、受入基準の waiver、成果の受け入れ、設計の選択。決定の種類ごとに、必要な材料（Evidence、Limits、選択肢）を添える。

### Review

criteria のカバレッジ、Evidence、Limits、Invalidation、Decision を1画面にまとめる。**「Ask agent to revise」は層を指定する**。実装を直すのか、設計をやり直すのか、意図から問い直すのかで、戻るコストが違う。

### Charter

プロジェクトのテーゼをヘッダーに置く。レビューのたびに「これに沿うか」を判断できる。

### Rules

蒸留されたルールの一覧と export。ルールごとに、元になった指摘と再発数を見る。

## 7. 段階導入

| 段階 | 内容 | 前提 | 出口 |
| --- | --- | --- | --- |
| P0 | 0120 に covers / limits を足す。0116 に criteria の器を足す | 0116 / 0120 | 証拠が基準に紐づく |
| P1 | done_level の導出と Progress / Review 表示 | P0 | L3 止まりが見える |
| P2 | Decision、Review の層、Needs you の決定種別 | P1 | 決定が記録される |
| P2.5 | OutcomeSource を1つ接続し、outcome を Evidence に足す | P2 | ループが1回閉じる |
| P3 | Rule の蒸留、export、再発計測 | P2.5 | 同じ指摘が減る |

各段階で既定は軽くする。すべての WorkItem に criteria を要求しない。コード変更はテスト、調査はデモかノートで足りる。

## 8. リスク

- **Jira 化**：プロセスが重くなり、使われなくなる。既定を軽くし、L4 / L5 は任意にする。
- **証拠のコスト**：手作業で証拠を作るとレビューが増える。テスト・diff・実行ログの自動収集を優先する。
- **done_level の誤用**：手で上げたくなる。導出のみにして、API を作らない。
- **プライバシー**：証拠にコードや秘密が混ざる。bounded、秘密除外、保存期間を決める。
- **ソロ利用**：1人でも回ること。チーム機能は Non-goal（0116 と同じ）。
- **外部依存**：コネクタの可用性・認可・レート制限でループが止まる。取得不能を unknown として扱い、成功に見せない。
- **意味のずれ**：外部メトリクスの定義がこちらの受入基準と一致しない。定義をコピーせず、参照と注記を持つ。

## 9. 既存 issue との関係

- **0116**：束ねる責務はそのまま。done_level と criteria を足すと肥大するので、**後続 issue** に分けるのがよい。
- **0120**：covers / limits は同じレスポンスの自然な拡張。ここに入れる。
- **0195**：意図・方針・判断の契約。レコードの形式と消費者、OutcomeSource の最初の1つをここで決める。
- **0104 / 0110 / 0114**：UI の受け皿。Review 画面と完了カードの変更先。
- **BOARD**：この提案では触らない。優先度は人の判断（D054）。

## 10. hns 自身の開発との関係

このモデルを、hns の開発で先に使う。issue = WorkItem、Result = Evidence、D = Decision。

製品の最初の利用者は自分たちであり、最初の顧客でもある。dogfooding で「重すぎる」「証拠が足りない」を先に検出できる。開発の運用は [management-operating-model.md](management-operating-model.md) に置く。

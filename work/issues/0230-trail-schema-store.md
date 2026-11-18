# 0230: Trail のスキーマと store（0004）

status: in-progress
priority: now
design: agreed
design-ref: D104 / work/research/trail-model-v1.md §6.1・§7
depends-on: -
touches: packages/core/src/types.ts, packages/core/src/trail.ts, packages/core/src/index.ts, packages/core/src/trail.test.ts, packages/store/src/migrations/0004-trails.ts, packages/store/src/migrations/index.ts, packages/store/src/schemas.ts, packages/store/src/parse.ts, packages/store/src/parse.test.ts, packages/store/src/schemas.test.ts, packages/store/src/repositories/trails.ts, packages/store/src/store.ts, packages/store/src/index.ts, packages/store/test/integration/store/trails.test.ts, packages/store/test/integration/store/migrate.test.ts, packages/store/test/integration/store/store.test.ts

## Intent

D104 で Trail を主単位にし、Task/カンバンを置き換えると決めた。最初に保存層を作り、GraphQL と UI は次の issue で載せる。この issue では Task をまだ消さない。

## Goal

0004 で trails 系テーブルを追加し、既存の tasks から backfill する。core に Trail の型と遷移表、store に row schema・parse・repository を用意する。

## Acceptance criteria

- [x] 0004 が空 DB と既存 DB の両方に適用でき、schema version が上がる
- [x] tasks が trails に backfill される（todo→draft, doing→active, done→merged, blocked→active + note）
- [x] Trail / TrailChange / TrailSession / TrailFinding / TrailDecision / TrailGate / TrailFeedback / TrailMetric / TrailEval / TrailNote の型と row schema がある
- [x] 不正な state / severity / gate は既定値に落とさず throw する
- [x] 状態遷移は core/trail.ts の表にあり、switch は全状態 + never
- [x] 既存の tasks 読み取りは壊れない（Task の削除は 0231）

## テスト条件

- C1: Given 既存の tasks 行、When migrate、Then 対応する trails 行が作られ、状態が写像される（リスク: データ移行、出所: D104）
- C2: Given 不明な state の row、When parseTrail、Then ValiError（リスク: 破損 row、出所: AGENTS.md の保存データ）
- C3: Given draft の Trail、When 最初の Change を足す、Then active に遷移する（リスク: 状態機械、出所: trail-model-v1 §1.2）
- C4: Given merged の Trail、When abandoned へ遷移、Then 拒否される（リスク: 不正遷移）

## テスト設計

- T1: C1 / integration / 0004 を既存 DB に適用して backfill を確認
- T2: C2 / unit / parseTrail の失敗
- T3: C3-C4 / unit / 遷移表の全ケース

## Notes

- SQL は [trail-model-v1](../../work/research/trail-model-v1.md) §6.1 を正とする。添付テーブルもここで作るが、API / UI は 0233。
- tasks テーブルは残す（INV-12 の加算のみ）。読み取り停止は 0231。
- 決定は D104。批判と対策は [trail-model-critiques](../../work/research/trail-model-critiques.md)。

## 未確定

- U-01: backfill を migration で行うか、アプリ起動時の lazy か / 仮説: migration / 影響: 実装量と失敗時の復旧 / 責任者: user / トリガー: 0004 のレビュー

## やらないこと

- GraphQL / Web（0231）
- Task の削除（0231）
- 添付の API / UI（0233）
- retention job（0233）

## Log

- 2026-11-17: 作成（D104）。

## Result

- verdict: **PASS**（reviewer-0230。blocking 0 / 低 8。低 3 件は統合前に修正）
- HEAD: f456066（main に ff 統合）。gate は exit 0（1674 tests / 1675、main で 154.5s）。
- **migration**: issue の「0004」は古い表記で、実際は **0010**（0004〜0009 は適用済み。後の migration を足すたびに番号を書き換える運用をやめたため）。
- **backfill**: todo→draft / doing→active / **done→closed** / blocked→active + `trail_notes` に 'blocked'。**`done → merged` は採らなかった**（task の done は「作業が終わった」で、Change を 1 つも持たない task に merged と言うのは**事実の捏造**）。`trail-model-v1` §7 と食い違う理由を migration の TSDoc に書いた。id は **`trail-<task id>`** で、0231 で Task を消した後も辿れる。
- **遷移表**: 7×7 の全 from→to を固定。**未知の状態は parse で拒否**（ValiError）、**`corrupt_row` は拒否の値**で例外にしない。`draft` + 最初の Change → active は **1 つの D1 batch**。
- **実経路**: 実 SQLite（miniflare D1）+ migration 0010 + repository + parser で create / get / list / update の往復。mutation 5 件（遷移表を緩める / 表を見ない / parse を通さない / Row→公開型の変換を外す / backfill の blocked を変える）を検出。
- **レビューで直したもの**: ①テスト専用の `TRAIL_TRANSITIONS_FOR_TEST` が core の公開面に出ていた（**in-source テスト**にして dist から消えたことを確かめた）②存在しない関数を指す TSDoc ③「全メソッドが parseTrail を通る」という実装と違う記述。
- **残件**: (1) **`listChanges` だけが `ValiError` を投げる**（他は `corrupt_row` を返す）。0231 の caller が来たときに揃える。(2) **手で編集した行は `head_commit = base_commit` を通る**（row schema は 2 列を比べない。`CHECK` と repository が通常の経路で拒否）。TSDoc に宣言された穴。(3) **誰も `store.trails` を呼んでいない**（0231 で GraphQL と Sidebar を足すまで起動しない）。
- **同時に直したもの**: integration のプロジェクトを **1 ファイルずつ**実行するようにした（`428a604`）。cf dev を使う 5 suite が同じ machine-wide lock を奪い合い、フルチェックで 60s のタイムアウトを起こしていた。check は 109s → 154s になるが通る。

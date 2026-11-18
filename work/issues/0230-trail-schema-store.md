# 0230: Trail のスキーマと store（0004）

status: open
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

- [ ] 0004 が空 DB と既存 DB の両方に適用でき、schema version が上がる
- [ ] tasks が trails に backfill される（todo→draft, doing→active, done→merged, blocked→active + note）
- [ ] Trail / TrailChange / TrailSession / TrailFinding / TrailDecision / TrailGate / TrailFeedback / TrailMetric / TrailEval / TrailNote の型と row schema がある
- [ ] 不正な state / severity / gate は既定値に落とさず throw する
- [ ] 状態遷移は core/trail.ts の表にあり、switch は全状態 + never
- [ ] 既存の tasks 読み取りは壊れない（Task の削除は 0231）

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

# roadmap — 段階とゲート

- 更新日: 2026-11-06
- 方式: 段階的確定・リスクベースゲート（`docs/sources/new_system_development_process.md`）
- 原則: 各段階の出口は「次に着手する範囲」で判定する。全体の完成は要求しない。

## 段階

| # | 段階 | 目的 | 出口条件（この範囲） | 状態 |
| --- | --- | --- | --- | --- |
| M0 | 設計ベースライン | 責務境界と未決の見える化 | ADR-001 と未決台帳が説明できる | **完了**（要件v0.3） |
| M1 | ExecutionEnv の実証 | 境界が実APIで成立するか | T-01 合格、契約v0.1 がレビュー可能 | **進行中**（T-01完了、T-02未） |
| M2 | Mutation と Editor | 黙って壊さない編集 | T-03/T-04 合格、Walking Skeleton | 未着手 |
| M3 | 2マシン・復旧・投影 | 分散配置の可否判断 | T-05/T-06/T-07 合格 | 未着手 |
| M4 | 最初の実用版 | 1つの目的を最後まで | 会話→編集→差分→再開が実利用で成立 | 未着手 |

## ゲート判定（現時点）

- **判定**: Go with Conditions（M1 の範囲）
- **進めてよい**: ExecutionEnv の調査、Workspace 契約の設計、T-02〜T-04 の PoC、最小の Walking Skeleton
- **保留**: 本番 Worker 認可の完成前の危険 Tool 公開、全 Provider の OAuth 統合、Workflow Engine の全詳細
- **条件**: 1.5.0 の exact pin。外部副作用の Exactly-once を主張しない。危険 Tool は限定公開
- **再判定トリガー**: T-02〜T-04 の結果、または要件#2 の解釈（U-01）が決まったとき
- **中止・見直し**: ExecutionEnv で Root 封じ込めが実装できない、または競合検出が実用にならない場合

## マイルストーンと試験の対応

| 試験 | マイルストーン | 状態 |
| --- | --- | --- |
| T-01 ExecutionEnv Conformance | M1 | **合格**（29/29, LocalExecutionEnv） |
| T-02 Workspace Access | M1 | **部分**（パス/symlink 7/7、監査・Worker越しは未） |
| T-03 Version Conflict | M2 | 未実施 |
| T-04 Crash/Mutation | M2 | 未実施 |
| T-05 Worker Connection | M3 | 未実施 |
| T-06 Durable Conversation | M3 | 未実施 |
| T-07 Progress Projection | M3 | 未実施 |
| T-08 Provider Compatibility | M4 | 未実施 |
| T-09 Git Readonly | M4 | 未実施 |
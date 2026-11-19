# 0111: Workflow graph editor（ノード・辺・版）

status: open
priority: next
design: pending
depends-on: 0110, 0130
touches: packages/web/src/components/WorkflowGraph, packages/web/src/screens/workflows/edit, packages/web/test/workflow-graph

## Goal

Workflow の DAG を、マウスとキーボードで編集する。
自由キャンバスではなく、ノード行 + 辺のリストを基本にし、検証と版の競合を明示する。

## Acceptance criteria

- [ ] ノード追加（agent / tool / human）、削除、prompt / command 編集
- [ ] 辺追加・削除。cycle と未知ノードを保存前に検出
- [ ] 保存は version 付き。409 は「他の変更と競合」として再読込/差分
- [ ] topological order の preview。human ノードがどこで止まるか分かる
- [ ] キーボードでノード/辺を移動・追加。focus-visible
- [ ] 空 / 1ノード / 大きいグラフ / 無効グラフ の状態
- [ ] テスト: validate、cycle、version conflict、keyboard

## Notes

- 0110 の run 画面と分ける。編集は明示的に edit mode へ
- グラフの正本は core の WorkflowGraph。UI 側で別の型を作らない
- 自由配置の座標は持たない。レイアウトは topological order から導く
- 0111 で graph の見た目を凝るより、検証と版を先に固める

## やらないこと

- 並列実行 / 分岐条件（0038 の範囲）
- キャンバス / ドラッグ&ドロップの自由配置

# 0232: Trail 詳細とレビュー面（Change・Finding・Decision・Gate）

status: open
priority: now
design: agreed
design-ref: D104 / work/research/review-experience-and-decisions.md §4.4
depends-on: 0231
touches: packages/server/src/graphql/mutations/trail.ts, packages/server/src/graphql/views.ts, packages/server/src/graphql/resolvers.ts, packages/server/src/graphql/context.ts, packages/web/src/app/TrailDetail.tsx, packages/web/src/app/viewModel.ts, packages/web/src/app/Shell.tsx, packages/web/src/__generated__/, packages/web/src/app/TrailDetail.test.tsx

## Intent

Trail の価値は「意図 → 変更 → 根拠 → 判断」を1画面で見て、30 秒で承認 / 差し戻しを決められること。保存層と一覧ができたので、レビュー面を作る。

## Goal

Trail 詳細に Intent / Changes / Findings / Decisions / Gates を出し、Change は base..head の diff をファイル → ハンク → 行で見せる。Approve / Ask agent to revise を記録し、承認を head commit に紐づける。

## Acceptance criteria

- [ ] Trail 詳細で意図・変更・指摘・判断・ゲートが見える
- [ ] Change は base / head の diff を既存の diff 実装（0009 / 0011）で描画する
- [ ] Finding は severity / source / status を持ち、blocking のみ既定表示
- [ ] Approve は head commit に紐づき、head が変わると無効になる
- [ ] Revise は指摘を次の Run の入力として渡せる
- [ ] Gate の状態と止まっている理由が1行で出る（human / tests / findings / freshness）

## テスト条件

- C1: Given base..head、When Trail 詳細、Then ファイル・ハンク・行の diff が出る（リスク: 表示、出所: 0009 / 0011）
- C2: Given approve 後の新しい head、When 再度 approve、Then 前の承認は無効（リスク: stale 承認、出所: D104）
- C3: Given high finding が open、When merge を試す、Then block され理由が出る（リスク: ゲート）
- C4: Given Revise、When 次の Run、Then 指摘が入力に含まれる（リスク: ループ）

## テスト設計

- T1: C1 / component / diff の描画
- T2: C2 / unit / approval の head 照合
- T3: C3 / unit / gate 評価
- T4: C4 / integration / revise → run

## Notes

- ハンクの Keep / Undo / Apply は Workspace の版付き書き込みを通す（UI を正本にしない）。
- 過程の再生を主役にしない。diff・テスト・未解決を先に。
- 承認は owner 1 人。四人眼を必須にしない。

## 未確定

- U-01: merge の実体（base ref を進めるだけか、checkpoint を打ち直すか）/ 仮説: base ref / 影響: 整合 / 責任者: user / トリガー: 実装前

## やらないこと

- 添付（0233）
- metric gate
- multi-repo の表示
- 行コメントのスレッド解決

## Log

- 2026-11-17: 作成（D104）。

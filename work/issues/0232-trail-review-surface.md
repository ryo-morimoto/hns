# 0232: Trail 詳細とレビュー面（Change・Finding・Decision・Gate）

status: in-progress
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

- [x] Trail 詳細で意図・変更・指摘・判断・ゲートが見える
- [x] Change は base / head の diff を既存の diff 実装（0009 / 0011）で描画する
- [x] Finding は severity / source / status を持ち、blocking のみ既定表示
- [x] Approve は head commit に紐づき、head が変わると無効になる
- [x] Revise は指摘を次の Run の入力として渡せる
- [x] Gate の状態と止まっている理由が1行で出る（human / tests / findings / freshness）

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

## Result

- verdict: **PASS**（reviewer-0232。blocking 0 / 低 8。低 5 件は統合前に修正）
- HEAD: 2b948de（main に ff 統合）。gate は exit 0（1742 tests / 1743、main で 158.6s）。
- **C2（承認の head 束縛）**: `decideTrail` は approve に **head 必須**（Change に無い head は store が `invalid_head` で拒否）。**`Trail.gates` は保存せず計算**するので、**新しい head を足すと human_review が `fail` に戻る**。**決定は追記専用**（UPDATE / DELETE なし）。
- **C3（gate）**: high の open finding で merge が block、**理由が 1 行**（`trailGateLine`）。**`ask` も block 扱い**。**tests は常に ask**（評価を記録する者が居ないので **pass を捏造しない**）。
- **C4（Revise）**: `nextRunInput` が open の指摘を **high 順・ファイル/ハンク付き**で文にし、`resolveFindingIds` は**決定と同じ D1 batch**。
- **Change の diff** は既存の `reviewDiff`（0009 / 0011）で **R2 の checkpoint pack** から読み、**読めない diff は空にせず `QueryFailure`**、binary は「変更あり（プレビュー不可）」。
- **ハンクの Keep / Undo / Apply** は **`@hns/workspace` の `applyVersionedWrite`**（版比較・temp・rename）を通し、**UI を正本にしない**。
- **実経路**: 本物の `createGraphQLFace` / 実 D1（0010）/ 本物の store / 本物の `reviewDiff` / web の compiled document で 9 本。mutation 3 件（著者）+ 5 件（レビュアー、**読めない diff を空 diff にする**を含む）を検出。
- **レビューで直したもの**: 同名 module（`review` が 2 つ）/ 存在しない field を指す TSDoc / `useScreenRead` と実装の食い違い / 未使用 interface の lint 警告 / テストヘルパに足した field を誰も見ていなかった。
- **U-01（merge の実体）は未決のまま**（issue の責任者は user）。**材料**: `base ref を進めるだけ`が、0154 の「1 run = 1 commit の checkpoint ref を CAS で 1 回だけ」と 0245 の「pack は内容キーで不変」の両方と衝突しない唯一の案。**checkpoint を打ち直す merge は両方と衝突する**。
- **未実装 / 未起動**: ①**ハンクの書き込みは production で起動しない**（machine 側の Workspace reach が前提。今は `unavailable`）②**R2 に pack が無い commit は diff が `NOT_FOUND`**（0154 / 0245 の実行が前提）③**sessions を Trail に結ぶ writer が無い**（`sessions` は常に空）④`listChanges` 等の budget 未積算 ⑤tests gate が常に ask なので merge は常に blocked（**意図的**）。
- **同時に直したもの**: `ed8066f` で **codegen stage の罠を恒久化**（`--conditions=source` が `@earendil-works` の dist-only な tarball を `src/` に解決して落ちる問題。3 レーンが手作業で回避していた）。

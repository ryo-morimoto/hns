# ゲート判定 0001 — M2 出口 → 会話の実結線

- 工程: M2（Mutation と Editor）の出口 / 次スライス（M2.5 会話の実結線）の入口
- 判定日: 2026-11-06
- 次に進める対象: **1つの会話で Agent が Workspace を触る経路**を、ローカル1マシンで通す
- 判断責任者: ユーザー（PM）。**承認**（2026-11-06）

## 1. 今回着手する範囲

- 対象: Pi Durable Harness の起動、会話の submit、Tool（read / write / bash）の登録、Progress の最小投影
- 対象外: Editor UI、2マシン、実 Provider の認証、Workflow、Project / Task
- 期待する成果: 1往復の会話で「読む → 編集する → 競合する」が Agent 経由で成立し、イベントが UI に流れる
- 確認方法: `work/poc/conversation` の E2E テストと、同じ経路の HTTP 越しの確認

## 2. 着手判断

- 必要な情報・準備: 揃っている
  - Pi Durable 1.5.0 の API・適合・再開は実測済み（[research](../research/pi-durable-1.5.0.md)）
  - Workspace の安全（条件付き書き込み・復旧・認可・sandbox）は T-02〜T-04 で検証済み
  - Model の鍵は無いが、pi-ai の `faux` provider で鍵なしにループを回せる（実 Provider は差し替え）
- 主要な未確定と影響: Provider 認証（U-05）、Tool セット、Progress の形式（U-13）、Worker 認可（U-03、今回はローカルのみ）
- 重大リスク・不可逆な判断: なし。ローカル・sandbox 内・危険な Tool は出さない
- 代替策・切戻し: faux → 実 Provider に差し替え。Workspace と UI には影響しない

## 3. 判定

- [ ] Go
- [x] **Go with Conditions**
- [ ] Limited Go
- [ ] Hold

- 許可する作業: 会話の実結線、Tool の登録（read / write / bash）、Progress の最小投影
- 制限・条件: 1マシン・ローカル。`bash` は必ず sandbox 経由。実 Provider は1つだけ試す
- 未決事項の担当者と期限: Provider の選択はユーザー。実接続の前に確認する
- 再判定日・トリガー: 会話1往復が通った時点、または実 Provider に切り替える時点
- 判断理由: Workspace 側の検証は十分。次の最大の未検証は「Agent とつながるか」で、ここを飛ばすと UI を作っても意味が確認できない
- 承認者・承認日: ユーザー / 2026-11-06

## 4. 未確定事項（上位のみ）

| ID | 未確定事項 | 仮説 | リスク | トリガー | 暫定対応 |
| --- | --- | --- | --- | --- | --- |
| U-05 | Provider と認証方式 | 正式APIキーを1つ | 高 | 実接続の直前 | faux で先行 |
| U-03 | Worker 認可・Shell 隔離 | ローカルは sandbox のみ | 高 | 2マシン化の前 | 1マシンに限定 |
| U-13 | Progress の形式 | Durable の watch から投影 | 中 | UI 着手時 | 最小の run 状態だけ |
| U-08 | Editor Buffer | 保存は Workspace 経由 | 中 | Editor 着手時 | 今回は出さない |
| U-09 | Workflow 形式 | versioned graph | 中 | Workflow 着手時 | 触らない |

## 5. 結果

会話1往復が通った（`work/poc/conversation` **10/10**）。

- Agent が `read_file` → `write_file` を呼び、Workspace の版チェックを通って書き込み。
- `bash` は sandbox 経由。root 外への書き込みは失敗。
- 古い版からの書き込みは `conflict` としてモデルに返り、ファイルは変わらない。
- ターン後に live task なし。

次の判断: Editor（U-08）と実 Provider（U-05）のどちらを先にするか。

## 6. 中止・見直し条件

- Tool の実行結果と Durable の再開が噛み合わない（replay の扱いが破綻する）。
- faux でも1往復が通らない（Harness の前提が誤っている）。
- Provider の認証が正式に取れず、実利用の見通しが立たない。
# 0216: code mode の評価セット（direct と code の比較）

status: open
priority: next
design: pending
design-ref: 0199（合意後に agreed）
depends-on: 0200, 0201, 0202
touches: work/eval/code-mode/**, work/issues/0216-code-mode-eval.md, work/research/code-mode-eval.md

## Intent

code mode を「作った」ではなく「効いた」で判断する。direct（現行）と code（codemode + subagent + 予算）を
同じタスクで比較し、既定化・拡張の判断材料を作る。UI は使わない。

## Goal

- 10 タスク × 3 回の評価ランナーを `work/eval/code-mode/` に置く。
- モデルごとに direct / code / code+subagents を比較し、`work/research/code-mode-eval.md` に「有効/限定的/不向き」と理由を書く。製品の設定は自動変更しない。
- 成功率・主モデルのトークン・子のトークン・ツール呼び出し・p50/p95・予算停止を記録する。
- 結果を `work/research/code-mode-eval.md` に表で残す。

## Acceptance criteria

- [ ] `work/eval/code-mode/tasks.md` に 10 タスク（下記）を、入力・期待・判定基準付きで書く
- [ ] `work/eval/code-mode/run.ts` が `openSession` を MemoryStorage で開き、direct / code / code+subagents を 3 回ずつ実行する
- [ ] モデルは `faux` で契約を固定し、実モデル（`OLLAMA` / `OPENCODE`）は `0152` の後で同じランナーに差し替える
- [ ] 各実行で `Turn.settlement`、`usage()`（0049）、ツールイベント、予算停止を JSON に残す
- [ ] 結果を `work/research/code-mode-eval.md` に、モデル × profile × タスクの表でまとめる
- [ ] 結果にモデルごとの推奨（`effective` / `limited` / `unsuitable`）と根拠を書く。製品コードの capability 表は作らない
- [ ] 判定: モデルごとに 10 中 7 以上で code が同等以上、3 以上で明確な改善。予算停止が正当な場合を除き、失敗率が悪化しない
- [ ] モデル差を記録する: コード生成の失敗、ツール呼び出しの誤り、自己修復、過剰な subagent 呼び出し
- [ ] ランナーは `node --conditions=source work/eval/code-mode/run.ts` で動く。製品コードを変更しないので `npm run check` は不要

## タスク（案）

| # | タスク | 何を測るか |
| --- | --- | --- |
| T1 | リポジトリ横断で設定キーの参照箇所を列挙 | コードで grep する |
| T2 | 失敗テスト 1 本の原因をログから特定 | 出力の絞り込み |
| T3 | 2 ファイルの小さな変更 | ツール呼び出し |
| T4 | 4 ファイルの変更 | 分割・整合 |
| T5 | 1,000 行の仕様メモから実装項目を抽出 | 長文の構造化 |
| T6 | 100KB のビルドログから原因 3 つ | 出力上限 |
| T7 | 1MB のログから異常時間帯 | 大容量（code mode の限界） |
| T8 | 依存更新の影響範囲 | 横断・見落とし |
| T9 | 既存差分のレビュー | 判断 |
| T10 | ドキュメントと実装の不一致 3 件 | 照合 |

## 設計

### 1. ランナー

- `openSession({ storage: new MemoryStorage(), models, registry: createRegistry(), model })`。
- `codeMode: { codemode: createNodeCodemodeAccess().access }`。`createNodeCodemodeAccess` は `@hns/agent/code-mode/node` から import する（0200 の subpath export）。
- 各タスクは独立した会話。3 回は同じ会話でなく、新しい会話で実行する（学習を避ける）。
- direct: `createConversation({ title, projectId, profile: directProfile })`。code: `setProfile(conversation.id, codeProfile)`、code+subagents: `setProfile(conversation.id, codeSubagentProfile)`。
  `directProfile = {toolSurface:"direct",subagents:false,limits}`、`codeProfile = {toolSurface:"code",subagents:false,limits}`、`codeSubagentProfile = {toolSurface:"code",subagents:true,limits}`。
- 判定は人手 or 期待文字列の一致。LLM judge は使わない（再現性）。

### 2. 記録

```json
{
  "task": "T1",
  "profile": "code",
  "model": "provider/model-id",
  "recommendation": "effective",
  "run": 1,
  "ok": true,
  "tokens": { "main": 1234, "sub": 567 },
  "tools": 8,
  "ms": 4200,
  "budgetStops": 0
}
```

- 本文・プロンプト・出力は保存しない（docs/observability.md）。件数・所要・成否だけ。
- `recommendation` は `effective` / `limited` / `unsuitable` のいずれか。
- `usage()` は 0049 の API。未実装なら `harness.usage()` を直接読まず、ランナー内で `UsageDoc` を読む（一時）。

### 3. 判定

- モデルごとに 10 タスク中 7 以上で code が direct と同等以上、3 以上で明確な改善。
- code の p95 が direct の 2 倍を超えるなら、そのモデルでは既定化しない。
- コード生成の失敗が多いモデルは「不向き」、限定的なら「限定的」と評価表に書く。製品の capability 表には書かない。
- 予算停止が「正しい停止」なら失敗に数えない（理由を記録）。
- 結果は `work/research/code-mode-eval.md` に残し、0215 の既定化判断に使う。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 10 タスク × 3 profile × 3 回 × モデル数が完走 | 高 | 受入2 |
| C2 | direct と code の記録が同じ schema（model / 推奨 を含む） | 中 | 受入4 |
| C3 | 本文・プロンプトが JSON に無い | 高 | observability |
| C4 | code の `budget.exceeded` が件数として出る | 中 | 受入4 |
| C5 | 判定表が `work/research/code-mode-eval.md` にある | 高 | 受入5 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C2 | シナリオ | eval（Node） | `work/eval/code-mode/run.ts` |
| T2 | C3 | 監査 | unit | ランナーの JSON schema |
| T3 | C4 / C5 | 集計 | eval | 結果表 |

## Notes

- 参照: `work/research/rlm-harness-feasibility.md` `6.1（V1 のタスクセット）/ `6.2、`work/research/rlm-l2-implementation-options.md` `5.2（K1〜K6）。
- 0152（実プロバイダ）が未完了の間は faux で契約だけ。実モデルの比較は 0152 の後。
- 10 タスクは永続 REPL 版の V1 と重なるが、code mode では「subagent / codemode / 予算」が効くかに絞る。
- ランナーは製品コードではない。`work/` の下に置き、`npm run check` の対象にしない。

## 未確定

| ID | 何が | 仮説 | 影響 | 責任者 | 期限/トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | 判定を人手にするか | 人手（期待文字列 + レビュー） | 再現性 | lead | 初回 |
| U-02 | 実モデルの選定 | Ollama / OpenCode の 2 つ | 比較 | lead | 0152 |
| U-03 | タスクの難易度 | 10 タスクで 60 実行 | 時間 | lead | 初回 |

## やらないこと

- ランナー（`work/eval/**`）を製品コードにしない。
- UI のテスト。
- マシン側カーネルの評価。
- LLM judge。

## Log

- 2026-11-17: 作成。code mode の効果を direct と比較する。

# 0229: ポリシー承認の UI（提案・差分・承認）

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §10
depends-on: 0228, 0160
touches: packages/web/src/routes/policy/, packages/web/src/routes/route.ts, packages/web/src/app/Shell.tsx, packages/web/src/routes/policy/policy.test.tsx

## Intent

人がポリシーの差分を読めなければ、承認は形だけになる。現在の active ポリシー、pending の提案、追加・削除される能力、review token の鮮度を 1 画面で見せ、承認・拒否を安全に行えるようにする。

## Goal

`/policy/:workspaceId` の画面を足す。提案フォーム（read/write roots、bash、network、理由）、差分表示、承認・拒否、stale の再読み込み、loading / empty / error を実装する。

## Acceptance criteria

- [x] active revision と pending proposals を Relay で読み、`document` の readRoots / writeRoots / bash / network を表示する
- [x] 提案フォームが read/write roots、bash、network、reason を入力でき、`proposePolicy` を呼ぶ
- [x] 差分を `added` / `removed` の atom で表示し、expansion / narrowing / mixed をラベルする
- [x] 承認・拒否が `decidePolicy` を呼び、成功後に一覧と active を再取得する
- [x] `approval_stale` は「提案が古い」と表示し、再取得を促す。黙って再送しない
- [x] loading / empty / error / 権限なし の 4 状態を持つ
- [x] キーボードで提案・承認・拒否に到達でき、フォーカスが戻る
- [x] `npm test -w @hns/web` と typecheck が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | active 1 件 + pending 0 件 → 画面 → active と empty | 中 | 契約 §10 |
| C2 | pending 1 件 → 画面 → 差分の added / removed が出る | 高 | S10 |
| C3 | 承認 → mutation → 一覧が更新される | 高 | S11 |
| C4 | 古い token → mutation → stale 表示、再送しない | 高 | TOCTOU |
| C5 | agent の principal → 承認ボタンが出ない / 押しても拒否 | 高 | 自己承認 |
| C6 | エラー → 画面 → error 状態と再試行 | 中 | UX |
| C7 | キーボードのみ → 提案 → 承認 → 完了 | 中 | a11y |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C6 | Relay の mock + fixture | unit | `packages/web/src/routes/policy/policy.test.tsx` |
| T2 | C7 | キーボード操作 | unit | 同上 |
| T3 | C3–C5 | 実 GraphQL | e2e | `e2e/`（該当時） |

## Notes

- 画面は「今の権限」と「増える権限」を分けて見せる。expansion は警告色、narrowing は通常色。
- 承認の前に review token を再取得しない。古ければ 409 を表示し、ユーザーに再読み込みさせる（黙って再送しない）。
- OpenShell の advisor の「提案 → リスク表示 → 承認」を参考にするが、auto-approve は出さない（D091）。
- UI の状態は Relay の store と React の一時状態だけ。サーバ状態を別キャッシュに置かない（D077）。

## 未確定

- route の形（`/policy/:workspaceId` か、設定画面のタブか）。0160 の配信と 0107 の設定画面に合わせる。
- workspace の選択 UI。既存の Shell の project / workspace から取る。

## やらないこと

- ポリシーの保存・承認の実装（0223）。
- 監査の画面。
- global policy。

## Log

- 2026-11-17: 作成（D091）。

## Result

- verdict: **PASS**（reviewer-0229。blocking 0。lead が検出不能の mutation 2 件を塞がせた）
- HEAD: 2acd5f7（main に ff 統合）。gate は exit 0（1631 tests / 1632、main で 68.9s）。
- **画面**: `#/p/:projectId/policy`（Shell の route と Sidebar のリンク）。active revision と全 proposal を 1 クエリで読み、`document` を readRoots / writeRoots / bash / network の表で表示。**提案フォーム**は `[]` を「変更なし」として送る（**サーバの `documentOf` と同じ解釈**を server の単体テストで固定）。**差分は added / removed の atom**（`exec` は「ファイルの書き込み」等に翻訳）で、**広げる（warn）/ 狭める / 両方 / 変更なし / 比較できない（danger）**をラベル。**`equal` は「承認しても権限は変わりません」**、**`unsupported` は承認・拒否できない**（0223 / 0228 の fail closed に UI も揃えた）。
- **stale**: `approval_stale` は「提案が古い」と表示し、**決定は 1 回だけ**（50ms 後にも回数を確認）。**拒否は読み直しを越えて残り、人が「閉じる」まで消えない**（狭い実装を mutation で検出）。成功は次の read が置き換える。
- **本物の resolver まで**: `packages/server/test/integration/graphql-web-operations.test.ts` が **web のコンパイル済み operation** を **本番の `createGraphQLFace` + 実 D1（workerd）** に投げ、`PolicyScreenQuery` / propose / decide の入力と応答を固定（**web → server の依存は増やしていない**）。
- **4 状態**（loading / empty / error / 権限なし）、**キーボードで提案 → 決定理由 → 承認 → フォーカス復帰**。
- **レビューで見つかって直したもの**: ①`UNSUPPORTED` でも承認できた（fail open）②`stale` 以外の拒否が次の読み直しで消えていた（TSDoc と実装のずれ）③`kept` を null にする mutation が**検出されなかった**（テストを足した）④Shell の policy route のテストが無かった ⑤active が null の分岐が `role="alert"` で「空」と「障害」を混同していた。
- **残件**: (1) **`canDecide` は route が常に true** で、**session の subject を読む配線（0108）待ち**。サーバの `policy_denied` が authoritative で、UI はその状態を描ける（断定しない文言にした）。(2) 再読込でフォーカスが 0ms の setTimeout 依存。(3) 決定後に提案フォームが unmount して入力が消える。(4) 狭い幅のレイアウト。(5) 実ブラウザでの視覚証拠（1280 / 320 / 200%）は未取得。

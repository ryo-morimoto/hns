# 0229: ポリシー承認の UI（提案・差分・承認）

status: open
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

- [ ] active revision と pending proposals を Relay で読み、`document` の readRoots / writeRoots / bash / network を表示する
- [ ] 提案フォームが read/write roots、bash、network、reason を入力でき、`proposePolicy` を呼ぶ
- [ ] 差分を `added` / `removed` の atom で表示し、expansion / narrowing / mixed をラベルする
- [ ] 承認・拒否が `decidePolicy` を呼び、成功後に一覧と active を再取得する
- [ ] `approval_stale` は「提案が古い」と表示し、再取得を促す。黙って再送しない
- [ ] loading / empty / error / 権限なし の 4 状態を持つ
- [ ] キーボードで提案・承認・拒否に到達でき、フォーカスが戻る
- [ ] `npm test -w @hns/web` と typecheck が通る

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
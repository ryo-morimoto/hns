# 0188: GraphQL を唯一の契約にする（REST 契約の撤去）

status: in-progress
priority: now
depends-on: —
touches: packages/core/src, packages/core/test, packages/core/README.md, packages/core/CHANGELOG.md, packages/store/src/schemas.ts, packages/store/test, packages/web/src, packages/web/test, docs/decisions.md, docs/packages.md, docs/auth.md, docs/typescript.md, docs/review.md, docs/automation.md, AGENTS.md, work/BOARD.md, work/issues/0037-http-contracts.md, work/issues/0145-worker-edge.md, work/issues/0176-graphql-endpoint.md, work/issues/0177-global-id.md, work/issues/0178-web-relay-environment.md, work/issues/0182-surface-inventory.md, work/issues/0036-web-ui.md, work/issues/0100-web-foundation.md, work/issues/0102-web-app-shell.md

## Goal

GraphQL（D055）を唯一のアプリ契約にし、**宣言だけあって実装の無い REST 面を残さない**。
`@hns/core` の意味を「系が合意する語彙（モデルと、その射影）」に確定する。`@hns/contract` は作らない（D059）。
REST 面は、それを実装する issue が schema・認証・handler を同じ変更で足す。

## Acceptance criteria

- [x] core から wire を削除: `http.ts` / `http-schemas.ts` / `contract.ts` を消し、モデルの型は `types.ts` に移す
- [x] `ERROR_CODES` / `ErrorCode` / `ErrorResponse` / `Health` / `DebugTick` / SSE 型 / passkey・secret・chat・run の封筒を削除
- [x] `ROUTES` と 49 本の route schema、`parseRequest` / `parseResponse` が存在しない
- [x] web の typed client / fixture を削除し、shell は `WorkspaceSource`（fixture 実装）で描ける
- [x] store / workspace / agent のテストが**期待値を変えずに**通る（モデルの振る舞いは変えていない）
- [x] D059 を decisions に追記し、D029 の意味の補足と D055 の REST の範囲を更新する
- [x] docs/packages.md・AGENTS.md・auth/typescript/review/automation の参照を更新する
- [x] 0037 を superseded、0145 を 3 面（GraphQL / WS / 静的）、0182 を「面ごとの再導入」に更新する
- [x] `npm run check` が通る（f4ca217 の clean worktree で成功）

## テスト条件（Example Mapping）

- 規則: core はモデルと射影だけを持つ。wire の要求・応答の封筒は契約ではない（実装する issue が持つ）。
  - 例: `Project` は core に残る。`ProjectCreate` は残らない。
  - 例: `Workflow` / `Automation` / `Firing` は永続するので core。`WorkflowCreate` は残らない。
  - 例: `FileRead` / `MutationResult` は workspace が返すので core。`FileWriteRequest` は残らない。
  - 疑問: chat の送信面（REST POST か WS メッセージか）は 0159 / 0176 が決める。0188 では宣言を消すだけ。
- 規則: どの面も、実装が無いのに宣言されない。
  - 例: `/api/*` の宣言が packages に 1 つも無い。
  - 例: web は `WorkspaceSource` だけを知り、HTTP のルート名を知らない。

## テスト設計

- 層: unit（store / workspace / agent / core）と、web の shell テスト（jsdom）。プロセスを跨がない。
- 既存テストは import の張り替えだけで通す（期待値は変えない）。これが「モデルを動かしていない」証拠になる。
- 新規: web で「`WorkspaceSource` の fixture 実装から shell が描ける」1 本。
- 削除: `core/test/{http,contract,schemas}.test.ts`、`web/test/{client,fixtures}.test.ts`。削除した契約のテストは
  面ごとの issue が持つ（復活させない）。

## Notes

- 前案の `@hns/contract` と「REST 22 本の残置」は取り下げ（user 判断: 未使用を残すと agent が現状を正常と誤認する）。
- SDL は `@hns/core/graphql`（0175 のまま）。成果物は `packages/web/schema.graphql`（0178）。
- 0182 の分類表は作らない。面ごとに issue が schema と handler を足す。

## やらないこと

- `@hns/contract` パッケージ、0145 / 0176 / 0177 / 0178 の実装、Relay、WS（0159）、passkey（0158）、machine（0147）。
- 49 ルートの schema の作り直し（面ごとに、実装する issue が書く）。
- `work/poc/` の変更。

## Log

- 2026-11-10: 作成（user 承認。D059 の採用）。
- 2026-11-10: core を撤去。モデルの型（Workflow / Automation / Firing など）は `types.ts` へ移し、
  wire の封筒・ROUTES・schema・parse を削除。id の schema は `codecs.ts` へ。store は JSON 列の
  検証 schema（graph / trigger / action）を自パッケージに持つ。store / workspace / agent のテストは期待値無変更。
- 2026-11-10: web の typed client と網羅 fixture を削除し、`WorkspaceSource` と `fixtureSource` で shell を描く。
  shell テストは 14 本そのまま通る。
- 2026-11-10: D059・docs/packages.md・AGENTS・auth/typescript/review/automation を更新。0037 を superseded、
  0145 / 0176 / 0177 / 0178 / 0182 / 0036 / 0100 / 0102 と BOARD を更新。
- 2026-11-10: 統合 commit 5cb0ae5 に含めた。
- 2026-11-10: reviewer-0188 が **FAIL**（blocking 2）。store schema の空文字と、core の README / CHANGELOG の
  wire 契約の記述。修正後に再 review する。

## Result

- verdict: **FAIL**（blocking 2）
- reviewer: reviewer-0188
- HEAD: f4ca217（clean worktree で `npm run check` 成功: lint / fmt / typecheck / test / build / knip）
- blocking:
  - **中 / `packages/store/src/schemas.ts:93-130` / 空の workflow id・cron・token が parse を通る。**
    旧 `packages/core/src/http-schemas.ts` は `const id = v.pipe(v.string(), v.minLength(1));` を
    `WorkflowNode` / `WorkflowEdge` / `AutomationTrigger` / `AutomationAction` に使っていた。
    移動後の store schema は `v.string()` で、空文字を受け付ける。再現（f4ca217 の clean worktree）:
    `v.safeParse(WorkflowGraphSchema, { nodes: [{ id: "", type: "agent", prompt: "p" }], edges: [] })`
    → `success: true`。`AutomationTriggerSchema` の `cron: ""` も `true`。
    修正: `id` を store schema に戻して該当 field に使い、空文字を拒否する回帰テストを
    `packages/store/test` に足す。作業ツリーには同じ修正案（未コミット・テストなし）がある。
  - **中 / `packages/core/README.md:11-30`, `packages/core/CHANGELOG.md:6` / 削除した wire 契約を今も説明。**
    README は `src/schemas.ts`・`GET/POST /api/...`・`ErrorResponse`・`Health`・`ChatRequest` を含む表を
    残し、changelog は "HTTP wire contract" を残す。D059 と実装に反する。修正: core を
    「モデル + `./graphql` 射影。要求・応答の封筒は面を実装するパッケージが持つ」に書き換える。
- non-blocking:
  - 低 / `docs/decisions.md:247,410,419` / D031 の `ErrorCode` と D043 の ROUTES は履歴として残る。
    D059 に置き換えの1行があると読み手が迷わない。
  - 低 / `work/issues/0188...:6` / `touches` に store schema / test / core README / CHANGELOG が無かった。
    この review で追記した。
- 未確認:
  - web の見た目・操作は変更なし。shell test 14 本は通過。visual review は対象外。
  - 空文字の拒否は既存テストで未覆盖（finding 1 の回帰テストで埋める）。
  - `npm run check` のテスト件数は clean worktree の出力からは取り直していない（gate は ok）。
- 修正後の再 review: 必要。

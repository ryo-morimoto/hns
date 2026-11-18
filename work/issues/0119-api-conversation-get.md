# 0119: 会話の単体取得と state のメタデータ

status: done
priority: now
design: agreed
depends-on: 0145, 0146
touches: packages/core/src/graphql, packages/server/src, packages/server/test

## Goal

会話画面が、一覧を引かずに1つの会話のメタデータ（title / project / archived / updated_at）を得る。
/api/state と会話メタの取得を1往復にまとめる。

## 設計（lead）

- **面は REST**（既存の `/api/*` に合わせる。GraphQL は対話の一覧に既にあり、0105 は単体を 1 往復で欲しい）。
- `GET /api/conversations/:id` は **session 認証**（未認証 401）。**deleted / 未知は 404**、archived は 200 で `archived: true`。
- `/api/state` の応答に **`conversation` の要約**を足す（0105 が一覧の線形探索をしない）。**加算**で、既存の field は変えない。
- 応答の型は **core の既存 DTO**（web で再定義しない）。

## Acceptance criteria

- [x] GET /api/conversations/:id を追加。Conversation を返し、deleted / 不明は 404
- [x] archived の会話は取得できる。UI がアーカイブ済みと表示できる
- [x] /api/state の応答に conversation の要約を含める（または GET と同時に取得できる形）
- [x] web 0105 が一覧の線形探索をしない
- [x] 契約テストと 404 / archived の server テスト

## Notes

- Conversation の型は core の既存 DTO。web で再定義しない
- 一覧の検索 / pagination は 0121。ここは単体だけ
- deleted_at の扱いは 0029 の論理削除に合わせる

## やらないこと

- 一覧の pagination（0121）
- 会話の検索（0121）

## Result

- verdict: **PASS**（reviewer-0119。blocking 0 / 低 8）
- HEAD: c9cd166（main に ff 統合）。gate は exit 0（1520 tests / 1521、main で 137.3s）。
- 確認: `GET /api/conversations/:id` は **session 認証**（未認証は face より前に 401）、**deleted と未知は同じ 404**（存在を漏らさない）、**archived は 200 で `archived:true`**、**id の形が外れたら 400**。応答は **core の `Conversation` DTO そのまま**（再定義なし）。`/api/conversations/:id/state` は **D1 の行 + object の `/rpc/state`** で、**object が持たなければ 404**（『無い』と『壊れている』を区別して返さない）。**復旧の向きは Object → D1 だけ**（index drain / `POST /rpc/reindex`）。
- 実経路: 実 edge → 実 D1（store の fake-D1 が node:sqlite で migration は本物）→ 実 Session object → 実 `@hns/agent`。**stub は DurableObjectNamespace だけ**。401 / 400 / 404 / 200（archived）を実測。mutation A〜C と seam の変異をレビュー担当が再実行。
- **面の新設**: `docs/contracts/conversation.md`（会話と state は Session Object / D1 の面で、workspace.md の checkpoint とは責務が違う）。README の表に 1 行。
- 非 blocking（follow-up）: `SEAMS` の一覧が手書き（型から導出すると新しい seam も検出できる）/ `ConversationStateSummary` の `archived` / `deleted` が呼ばれない / TSDoc の `/api/state` の残存 / `SESSION_NAME_HEADER` に読み手が無い / `forgetStore` が死んだ公開面 / `handleStateRpc` の TSDoc が「object が持つ」と言い過ぎ / namespace の stub が実物でない / 200 の失敗 body を混ぜる余地。
- **実装した ≠ 起動する**: 面は配線済み（deploy で使える）が、**呼ぶ UI は 0105**。

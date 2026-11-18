# 0271n: 会話の rename / archive / delete の面

status: in-progress
priority: now
design: agreed
design-ref: lead 裁定 / D059 / D078 / 0119 / 0105 の Result / 0029（PoC の PATCH・DELETE）
depends-on: 0119
touches: packages/server/src/conversations/, packages/server/src/edge/handler.ts, packages/server/src/graphql/, packages/store/src/repositories/, packages/web/src/screens/conversation/

## Intent

0105（Conversation 画面）は受入に「rename / archive / delete」を持っていたが、**0029 は done と書かれているのに、その面（PATCH / DELETE）は PoC にしか無く、このパッケージには入っていない**。画面は archived の表示だけを実装し、操作は無い。人の操作から会話を管理できないままになっている。

## 設計（lead）

- **面は REST**（0119 の `/api/conversations/:id` に **`PATCH`** と **`DELETE`** を足す。同じ face・同じ認証・同じ 404 の規約）。GraphQL は増やさない。
- `PATCH` の body は **`{ title?: string }`** と **`{ archived?: boolean }`** の**両方を許可**し、**与えられた項目だけ**を変える（`rename` と `archive` / unarchive が 1 面で済む）。`title` は **1..200 文字、制御文字を拒否**。`archived` は `boolean`。
- `DELETE` は **論理削除**（`deleted_at`）で、**以後 404**（0119 の規約どおり deleted と未知を区別しない）。**すでに削除済みでも 404 を返す**（冪等だが情報を漏らさない）。
- **書き込み先は D1 の行だけ**（`conversations`）。**object の metadata は書き換えない**（D078 の向きは Object → D1 で、ここは人が起点なので **D1 → Object はやらない**）。index drain が object から書き直すのは**次の活動のとき**で、それまでは D1 の値が画面に出る（0119 が D1 を読み正本としているため整合）。**この非対称を TSDoc と contracts に 1 段落**。
- **Undo（archive）**: 画面側は `PATCH {archived:false}` を**同じ面で**呼ぶ（サーバに特別な Undo は作らない）。**delete の確認**は画面側。
- store に `rename` / `setArchived` / `softDelete` を足す（`touch` と同じ形で、**行が無ければ no-op**）。

## Acceptance

- [x] rename / archive / delete の**面を 1 つに決める**（REST か GraphQL。D059 の「面を実装する issue が同時に認証を宣言する」に従う）
- [x] archive は **Undo** が効く（0105 の受入どおり）
- [x] delete は**確認**があり、**論理削除**（0029 の形）で 404 になる
- [ ] 画面から呼べる（0105 の会話ヘッダー） — **未達**: 0105 の会話ヘッダーへの配線は別（次の follow-up）
- [x] 実経路で 1 本（実 edge → 実 D1 → object の metadata → index drain）

## Log

- 2026-11-18: 0105 のレビューで「0029 の面が存在しない」ことが判明。**0029 の Result は PoC の記述で、製品の面ではない**（done の意味が実装より広い）。設計は next で決める。

## Result

- verdict: **PASS**（reviewer-0271n。初回 FAIL 1（人の rename / archive / delete が次の turn 1 回で消える・delete は復活）→ 修正 → PASS）
- HEAD: ab5dd89（main に ff 統合）。gate は exit 0（1611 tests / 1612、main で 141.4s）。
- **面**: `PATCH /api/conversations/:id`（`{title?}` / `{archived?}` を与えられた項目だけ。未知キー・配列・null・非 JSON は 400、title は**コードポイントで 1..200**・制御文字を拒否・trim しない、応答は書き込み後に D1 から読み直した行）と `DELETE`（論理削除、以後 GET / PATCH / 2 回目の DELETE が同じ 404、tombstone を再刻印しない）。未認証は body 未読で 401、`Allow: GET, PATCH, DELETE`、`/state` への PATCH は 404。
- **所有の規則（今回の中心）**: `conversations.edited_at`（migration 0009、加算のみ）。人の書き込みが `edited_at` を立て、**index の書き込み（drain も reindex も）は `keepEdited` の 1 箇所で「edited_at があれば人の列を書かない」**。`created_at` / `updated_at` / `indexed_at` は Object のもの。
- **実経路**: 実 edge → 本番 face → 実 D1 → 実 Session DO → **本物の runtime で turn を 1 回**回し、rename / archive / delete が**残る**こと、**delete が復活しない**こと、**reindex でも人の値が残る**ことを実測。
- **レビューで見つかって直したもの**: ①`rename` / `setArchived` / `softDelete` が `updated_at` を触らないため、**touch した次の drain が人の値を上書きしていた**（実測: **送信するだけで rename が消え、delete は復活**）②**以前のテストが object の `send` を偽装していて、turn が metadata を dirty にせず、defect を再現できていなかった**（緑が嘘だった）③契約文の「drain で戻る」が実測と違った。
- **残件**: (1) **画面からの配線は未達**（0105 のヘッダー。`PATCH` / `DELETE` を呼ぶ UI）。(2) `edited_at` を消して Object を正に戻す操作は未実装（契約に「将来」と明記）。(3) 低: `packages/server` 直下の `npx vitest` は alias が効かず dist を読む（**mutation は root から `--project` で**、`testing.md` に 1 行足す価値）/ `turnAndDrain` のポーリング条件 / `rename` と `setArchived` が 2 文で `edited_at` を 2 回刻む / `ConversationRowSchema` が `edited_at` を持たない。

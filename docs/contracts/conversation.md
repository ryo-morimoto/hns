# 契約: 会話の単体取得と state（0119）

2026-11-18 / **この面の契約の正本**。実装は `server/src/conversations`（edge の face）、`server/src/do/session-rpc.ts` の `GET /rpc/state`、`server/src/edge/handler.ts` のルート。失敗の語彙は [failures.md](failures.md)、認証は [auth](auth.md)、索引は [journal-index](journal-index.md)。

## 面

- `GET /api/conversations/<id>`（REST、**session 認証**）はその会話の **core の `Conversation` をそのまま**返す（`{ ok: true, conversation }`）。web / server で型を再定義しない。
- `GET /api/conversations/<id>/state` は **Object の state と会話のメタデータを 1 往復にまとめたもの**（`/api/state` という別の面は置かない。会話に紐づく state なのでこの面の一部）。Object の `GET /rpc/state?conversation=<id>` の応答に **`conversation`（同じ DTO、D1 から）を加算**する。既存の field の綴りと意味は変えない。
- `GET /rpc/state` は**内部**（Worker だけが呼ぶ）。会話の id を **URL で名指し**する: Object の名前は会話の id だが、旧 `default` の Object は複数の会話を持つため、名指しが無いと「どの会話の state か」が決まらない。
- 一覧・検索・pagination は 0121。ここは単体だけ。
- `PATCH /api/conversations/<id>`（0271n）は **rename と archive / unarchive を 1 面で**行う。body は `{title?: string}` と `{archived?: boolean}` で、**与えられた項目だけ**を書く（`{title}` は rename、`{archived: true}` は archive、`{archived: false}` が**Undo**、両方あれば両方）。`title` は **1..200 文字（コードポイント単位。絵文字は 1 文字）で、制御文字（U+0000–U+001F・U+007F–U+009F）を拒否**する（trim も正規化もしない）。`archived` は `boolean`。**未知のキーは `invalid_request`（400）**（strict。`project_id` や `deleted_at` を送っても素通しにしない）。body が JSON オブジェクトでない（配列・`null`・JSON でない）も 400、`{}` は「何も変えない」で 200。応答は `{ ok: true, conversation }` で、**書いた後の行を D1 から読み直したもの**。
- `DELETE /api/conversations/<id>`（0271n）は**論理削除**（`deleted_at`）で、応答は `{ ok: true, id, deleted_at }`。以後、その path の GET / PATCH / DELETE は**すべて未知の id と同じ 404**。**すでに削除済みでも 404**（冪等だが、削除済みだったことは漏らさない）。

## WS の `send` / `abort`（0105、D077）

この面ではないが、会話を開いた画面が次にすることなので、ここから読めるようにしておく。**正本は [live-ws](live-ws.md)**。

- 送信は WS の `send`（`{conversationId, clientMessageId, text}`）で、REST POST は無い。答えは `accepted`（`messageId`）か `rejected`（`code`）。同じ `clientMessageId` は同じ turn で、再接続の再送は二重に実行されない。
- 停止は `abort`（`{conversationId}`）。run が終わったことは view（中断された assistant entry）で届き、`abort` 自身は frame を返さない。
- **1 回の会話訪問は 1 本の socket**。画面は自分で 2 本目を開かない。

## 失敗

- **404 は 3 つを同じ答えにする**: D1 に行が無い会話、論理削除済み（`deleted_at`、[0029](../../work/issues/0029-conversation-management.md)）、**D1 に行はあるが Object がその会話を持たない**。存在や状態を漏らさない。
- **archived は 200** で `archived: true`（0105 がアーカイブ済みと表示できる）。
- id は `[\w-]{1,128}`。外れるものは **400**（`invalid_request`）。未認証は edge の **401**（`PATCH` / `DELETE` も同じ: 未認証は body を読まずに 401）。`PATCH` の body が不正（未知のキー・型違い・長さ・制御文字・JSON でない）も **400**。DB / Object の不達は **503**。`PATCH` / `DELETE` が使えるのは `<id>` の path だけで、`/state` に `PATCH` を送ると **404**。

## どちらを読むか（正本）

- **メタデータは D1 が正本**。サーバは `conversations` の行だけを読み、Session Object には尋ねない。Object の metadata は行の**元**（行はその写し）だが、先に Object を読むと、2 つが食い違ったときどちらが答えかが呼び出しごとに変わる。
- **Object の state は Object が正本**。状態の field は Object の応答にだけあり、メタデータの field は `conversation` の DTO にだけある。重ねない。

## 食い違ったとき（行はあるが Object が持たない）

- `/state` は **404** を返す。行は Object の metadata の**写し**（[journal-index](journal-index.md)、D078）で、**原物の無い行は会話ではない**。
- 呼び出し側はこの 404 を「削除・未知」と**区別できない**（区別できてはならない: 読める会話が無い）。状態を確かめるのは operator の道具: `index_state` の `last_error*`、dirty な行の数、Object 自身。
- **直す向きは Object → D1 だけ**（人の書き込みが D1 に乗る話は下の「人の書き込みと、その寿命」）: (1) その Object の次の **index drain**（RPC / alarm の後）が行を Object の metadata に合わせて書き直す・消す、(2) `POST /rpc/reindex` が project の行を Object から作り直す。直るまでは metadata（`/api/conversations/<id>`）は行を返し続け、`/state` だけが「原物が無い」と言う。

## 人の書き込み（0271n）と、その寿命

- **`PATCH` / `DELETE` が書くのは D1 の `conversations` の行だけ**。Object の metadata は書き換えない（Object へ書く面が無い）。したがって向きは D078 のまま **Object → D1** で、人の編集はその向きに乗らない。
- **この非対称は意図した契約で、寿命がある**。この face の読みはすべて D1 からなので、編集は**すぐ答えに出る**。だが Object は古い title と作成時の `isArchived` を持ったままで、Object がその行を書くとき（drain、`POST /rpc/reindex`）**Object の metadata が行を上書きし、人の title / archive は消える**。削除の tombstone も、Object が行を書き直したり消したりすれば「削除済み」ではなく「未知」になる。**編集が保つのは、Object がその行を書き直すまでの間**。永続させるには Object の metadata へ書く経路が要るが、この face はそれを持たない（0119 の「行は写し」の原則を破らないため）。実経路テスト（`packages/server/src/conversations/face.edge.test.ts`）が両方向とも固定している。

## 変わったとき

- 応答の形を変える（`PATCH` / `DELETE` を含む）: このファイル・face の TSDoc・server の実経路テスト（`conversations/face.edge.test.ts`）を同じ変更で。`conversation` の形は core の `Conversation` が正本なので、変えるなら core の型の変更。
- 404 / 400 / 401 の割り当てを変える: このファイル + edge の 401 のテスト（[auth](auth.md)）。

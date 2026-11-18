# 契約: 会話の単体取得と state（0119）

2026-11-18 / **この面の契約の正本**。実装は `server/src/conversations`（edge の face）、`server/src/do/session-rpc.ts` の `GET /rpc/state`、`server/src/edge/handler.ts` のルート。失敗の語彙は [failures.md](failures.md)、認証は [auth](auth.md)、索引は [journal-index](journal-index.md)。

## 面

- `GET /api/conversations/<id>`（REST、**session 認証**）はその会話の **core の `Conversation` をそのまま**返す（`{ ok: true, conversation }`）。web / server で型を再定義しない。
- `GET /api/conversations/<id>/state` は **Object の state と会話のメタデータを 1 往復にまとめたもの**（`/api/state` という別の面は置かない。会話に紐づく state なのでこの面の一部）。Object の `GET /rpc/state?conversation=<id>` の応答に **`conversation`（同じ DTO、D1 から）を加算**する。既存の field の綴りと意味は変えない。
- `GET /rpc/state` は**内部**（Worker だけが呼ぶ）。会話の id を **URL で名指し**する: Object の名前は会話の id だが、旧 `default` の Object は複数の会話を持つため、名指しが無いと「どの会話の state か」が決まらない。
- 一覧・検索・pagination は 0121。ここは単体だけ。

## 失敗

- **404 は 3 つを同じ答えにする**: D1 に行が無い会話、論理削除済み（`deleted_at`、[0029](../../work/issues/0029-conversation-management.md)）、**D1 に行はあるが Object がその会話を持たない**。存在や状態を漏らさない。
- **archived は 200** で `archived: true`（0105 がアーカイブ済みと表示できる）。
- id は `[\w-]{1,128}`。外れるものは **400**（`invalid_request`）。未認証は edge の **401**、DB / Object の不達は **503**。

## どちらを読むか（正本）

- **メタデータは D1 が正本**。サーバは `conversations` の行だけを読み、Session Object には尋ねない。Object の metadata は行の**元**（行はその写し）だが、先に Object を読むと、2 つが食い違ったときどちらが答えかが呼び出しごとに変わる。
- **Object の state は Object が正本**。状態の field は Object の応答にだけあり、メタデータの field は `conversation` の DTO にだけある。重ねない。

## 食い違ったとき（行はあるが Object が持たない）

- `/state` は **404** を返す。行は Object の metadata の**写し**（[journal-index](journal-index.md)、D078）で、**原物の無い行は会話ではない**。
- 呼び出し側はこの 404 を「削除・未知」と**区別できない**（区別できてはならない: 読める会話が無い）。状態を確かめるのは operator の道具: `index_state` の `last_error*`、dirty な行の数、Object 自身。
- **直す向きは Object → D1 だけ**: (1) その Object の次の **index drain**（RPC / alarm の後）が行を Object の metadata に合わせて書き直す・消す、(2) `POST /rpc/reindex` が project の行を Object から作り直す。直るまでは metadata（`/api/conversations/<id>`）は行を返し続け、`/state` だけが「原物が無い」と言う。

## 変わったとき

- 応答の形を変える: このファイル・face の TSDoc・server の実経路テスト（`conversations/face.edge.test.ts`）を同じ変更で。`conversation` の形は core の `Conversation` が正本なので、変えるなら core の型の変更。
- 404 / 400 / 401 の割り当てを変える: このファイル + edge の 401 のテスト（[auth](auth.md)）。

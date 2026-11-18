# 契約: GraphQL（面・失敗・上限）

2026-11-18 / L6 M2 の続き。**この面の契約の正本**。実装は `@hns/core/graphql`（SDL の生成）と `server/src/graphql/`（`buildSchema` / handler / resolver）。失敗の語彙は [failures.md](failures.md)、認証は [auth](auth.md#面ごとの認証契約)。

## 1 つの面

- アプリの契約は **GraphQL 1 つ**（`/graphql`）。REST は「その機能を実装する issue が schema・認証・handler を同じ変更で足す」ときだけ（D059）。**宣言だけの面を置かない**。
- typed client は `@hns/core/graphql` が生成する SDL から relay の codegen で作る。**SDL は手で書かない**（生成物は `packages/web/schema.graphql` と `__generated__/`）。

## 失敗

- 想定内の失敗は **union メンバー**で返し、HTTP は **200**（`QueryFailure` / `MutationFailure`）。
- 失敗型は `failureType(name, codes)` で組み、コードは `FailureCodeOf<"graphql">`（[failures.md](failures.md) の表の graphql 行）。
- **要求が成立しない入力**（変数 coerce の失敗・未知のフィールド・未知の operationName）は **400** で、union ではない。
- 欠陥（想定外の throw）は **500**（`GRAPHQL_INTERNAL`）。union に丸めない。
- `MutationFailure` と `QueryFailure` は**別の型**だが、コードの綴りは面をまたいで 1 つ（failures.md）。

## Mutation

- Mutation の root は feature ごとの `mutations/<name>.ts` を集めたもの。**Mutation が 1 つも無い間は schema に Mutation を出さない**（空の root を作らない）。
- resolver は**境界で認可**する（session の `sub` と所有者）。UI の状態や client が送った id を信じない。
- `createProject` が最初の実例（0127）。
- **`sendMessage(input: SendMessageInput!)`**（0270n）が会話への送信の面。`conversationId` は `Conversation` の global id（別 type や raw id は `invalid_request`）、`text` は session 契約の `MAX_INPUT_LENGTH`（空・超過は `invalid_request`）。Worker が D1 の active policy を読んで **snapshot（revision / hash / document）を body に載せ**、Session DO の `POST /rpc/conversations/<id>/messages` に転送する（`src/graphql/send-message-port.ts`）。**REST の送信面は作らない**（D059 / D077）。結果は `SendMessagePayload { submissionId, status }` か `MutationFailure`。

## deploy の env と起動の 3 状態（0270n）

granted tool path は **`HNS_AGENT_URL` / `HNS_MACHINE_ID` / `HNS_CONTROL_PLANE_KEY` の 3 つが揃ったとき**だけ開く。
`src/do/tool-path-mode.ts` の `toolPathMode` が唯一の判定で、**全部ある = granted / 全部無い = Phase 0 / 一部だけ = 起動時に fail**
（edge は全経路 503、Session は `#initialize` で throw して 503）。**黙って Phase 0 に落ちない**。
エラーの文言は**どの binding が足りないか**を名指しし、**値を出さない**。deploy は `HNS_MACHINE_ID` の binding を
dry-run の一覧に出す（**development でも必須**。既定値を置くと、ツールを渡すつもりの開発 deployment が
名指ししていない machine に繋ぐ）。`npm run deploy:check` は `HNS_MACHINE_ID=<id>` を要る。

## 上限

- 深さ・複雑度・行数・body の上限は Query と Mutation で同じ関数・同じ値。body は edge の `readBody`（1MiB）を通す。
- 超過は 200 の union（`limit_exceeded`）か 400（要求が成立しない場合）で、既存の分類に従う（[observability](observability.md) の http イベントに記録）。

## 変わったとき

- 失敗型やコードを変える: このファイル・`failures.ts`・`failure-type.ts`・SDL の再生成・relay の再生成を同じ変更で。
- **SDL の差分はレビューで必ず読む**。worktree の codegen はメイン checkout のサーバを読むことがあるので、[process](../procedures/process.md) の「並行変更」の手順で自分のサーバ由来であることを確かめる。

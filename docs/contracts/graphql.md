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

## Trail の面（0231 / D104）

Task と TaskStatus は SDL から消え、代わりに Trail 系の型と閉じた enum が出る（`Trail`・`TrailChange`・`TrailSession`・`TrailFinding`・`TrailDecision`・`TrailGate`、`TrailState` ほか）。**Task を返す query は無い**（`trails` がその読み）。

- **`trails(projectId: ID, first: Int)`**（Query）: `projectId` は `Project` の global id（別 type や raw id は `invalid_request`）。**省略すると全 project** の Trail を新しい順で返す（Sidebar は project ごとに読む）。成功は `TrailList { trails: [Trail!]! }`、失敗は `QueryFailure`。
- **`trail(id: ID!)`**（Query）: `Trail` の global id だけを受ける。成功は `TrailPayload { trail: Trail! }`。**無い Trail は `NOT_FOUND`**（空の payload にしない — 画面が「消えた」と「読み込み中」を区別できるように）、**この build が読めない行は `UNAVAILABLE`**（store の `corrupt_row`。空の一覧に潰さない）。他の失敗は `INVALID_REQUEST`（`Trail` でない id）と `UNAVAILABLE`（DB が開けない）。
- **`createTrail(input: CreateTrailInput!)`**（Mutation）: `projectId`（`Project` の global id、存在しない project は `invalid_request`）、`title`、任意の `description` / `acceptance` / `kind` / `priority`（`feature` / `normal` が既定）。**state は入力にしない**（`draft` で始まり、遷移は表に従う）。作成者は session の subject。成功は `CreateTrailPayload { trail }`、失敗は `MutationFailure`。
- **`updateTrail(id: ID!, input: UpdateTrailInput!)`**（Mutation）: 与えた欄だけを置き換える。**state は変えない**（状態遷移は 0232 のレビュー面の mutation が表に問い合わせる）。無い Trail は `NOT_FOUND`、読めない行は `UNAVAILABLE`。成功は `UpdateTrailPayload { trail }`、失敗は `MutationFailure`。
- **`Trail.changes: [TrailChange!]!`**: Trail の id から読む（列ではない）。`baseCommit` / `headCommit` は保存値そのまま。読めない Change は `UNAVAILABLE`。
- **`Trail.sessions` / `findings` / `decisions`**（0232）: 同じく id から読む。sessions は古い順、findings と decisions は新しい順。読めない行は `UNAVAILABLE`（空の一覧に潰さない）。
- **`Trail.gates`（計算）/ `Trail.gatesRecorded`（記録）**（0232）: `gates` は `TrailGates { line, lines { gate, status, detail } }` で、head・finding・decision・freshness から**その都度**計算する（`trail_gates` を読まない — 保存値は時点の答え）。`line` が C3 の一行（`merge: ready` / `merge: blocked — …`）で、`ask` も block 扱い。`gatesRecorded` は `trail_gates` の証拠を新しい順で返す。
- **`TrailChange.diff: TrailChangeDiffResult!`**（0232）: その Change の `base..head` を 0009 / 0011 の diff 実装で読む。成功は `ReviewDiff { baseCommit, headCommit, added, removed, files { path, change, added, removed, previewable, hunks { baseStart, headStart, lines { kind, text } } } }`、失敗は `QueryFailure`（**空の diff にしない** — 空は「変更なし」に見える）。checkpoint の pack がまだ無い commit は `NOT_FOUND`。
- **`decideTrail(input: DecideTrailInput!)`**（0232・Mutation）: `trailId`・`action`（`APPROVE` / `REQUEST_CHANGES` / `REJECT`）・任意の `note`・`changeId`・`headCommit`・`resolveFindingIds`。**approve は head を必ず名乗り、Trail の Change に無い head は `INVALID_REQUEST`**（C2）。`resolveFindingIds` の指摘は同じ batch で `resolved` になる。成功は `DecideTrailPayload { decision, nextRunInput }` で、`nextRunInput` は**開いている指摘を次の Run の入力にした文**（C4）。
- **`raiseFinding(input: RaiseFindingInput!)`**（0232・Mutation）: `trailId`・`severity`（`HIGH`/`MEDIUM`/`LOW`/`NONE`）・`source`（`AGENT`/`TEST`/`HUMAN`）・`summary`・任意の `file`/`hunk`/`changeId`。成功は `RaiseFindingPayload { finding }`。
- **`keepHunk` / `undoHunk` / `applyHunk(input: ReviewHunkInput!)`**（0232・Mutation）: `changeId`・`path`・`headStart`・`expectedVersion`。**Workspace の版付き書き込み**（`applyVersionedWrite`）を通す。成功は `ReviewHunkPayload { diff }`（書き込み後に読み直した diff）、版が違えば `CONFLICT`、書ける workspace が無い deployment は `UNAVAILABLE`（worker に書き込み先が無い。実装と起動は別 — 0232 の Result 参照）。

## 上限

- 深さ・複雑度・行数・body の上限は Query と Mutation で同じ関数・同じ値。body は edge の `readBody`（1MiB）を通す。
- 超過は 200 の union（`limit_exceeded`）か 400（要求が成立しない場合）で、既存の分類に従う（[observability](observability.md) の http イベントに記録）。

## 変わったとき

- 失敗型やコードを変える: このファイル・`failures.ts`・`failure-type.ts`・SDL の再生成・relay の再生成を同じ変更で。
- **SDL の差分はレビューで必ず読む**。worktree の codegen はメイン checkout のサーバを読むことがあるので、[process](../procedures/process.md) の「並行変更」の手順で自分のサーバ由来であることを確かめる。

# Artifacts B issue レビュー（0243〜0248）

2026-11-17 / 対象: 0243 / 0244 / 0245 / 0246 / 0247 / 0248

## 反映（2026-11-17）

- B1 pack wire / binary endpoint / deadline 分離 → 0243 / 0244 / 0245 に反映。
- B2 GraphQL の所有権 → 0247 から GraphQL を外し、0248 を唯一の所有者にした。
- B3 0246 の分割 → adapter は 0246、観測・kill switch・ローカルシミュレータは 0249。0246 に env の最小 kill switch を残した。
- B4 token の一時型 → `MirrorTarget`（一時）と `MirrorState`（永続）を分離。
- B5 packBytes / maxBlobBytes → `CheckpointRecord` と `checkpointRun` の結果に追加。
- B6 mirror 遷移表 → 0243 に追加。
- 0243 を `now` に上げた。0244 と 0247 は 0243 の後に並列可。
## 0. 総評

- 契約先行（0243）・依存順・touches の明示は良い。0243 を最初に置いた判断は正しい。
- ただし **pack の転送契約**と **GraphQL の所有権**が未定義で、このまま並列に流すと 0244/0245 と 0247/0248 が同じ場所で壊れる。
- 0246 は repo / token / push / limits / observability / kill switch を1つに詰めており、1 issue 1目的に反する。
- 以下、**開始前に直すべきブロッカー**と、**直した方がよい点**に分ける。

## 1. ブロッカー

### B1. pack をどう Worker に渡すかが未定義（0244 / 0245）

- machine agent の wire は JSON の `Operation` だけ（`packages/machine/src/wire.ts` / `agent.ts`）。`checkpointRun` は pack を `Uint8Array` で返すが、JSON に 64MiB を載せる設計になっていない。
- 0244 は「`application/x-git-pack` へ送る」と書くが、**署名・サイズ上限・Content-Type・エラー応答・streaming** が未定義。0245 は「prepare が machine を呼んで pack を受け取る」と書くが、`MachineFiles.send` は JSON 専用。
- 修正: 0243 に `CheckpointPackTransport`（upload(runId, bytes) / maxBytes / content-type）を定義し、0244 で signed binary endpoint、0245 で受信・R2 書き込みを実装する。pack は operation の応答に含めない。

### B2. GraphQL の所有権が衝突（0247 / 0248 / 0231 / 0232）

- 0247 と 0248 が `graphql/resolvers.ts` / `schema.ts` を触り、0231（Trail GraphQL）・0232（Trail 詳細）とも競合する。
- 修正: 0247 は **server service のみ**（`ReviewSource` + `reviewDiff`）にし、GraphQL は 0248（0232 の後）に寄せる。0248 が GraphQL の唯一の所有者。

### B3. 0246 が大きすぎ、kill switch / 観測 / repo 名が抜けている

- repo 遅延作成、token、push、検証、状態、上限 skip を1 issue に詰めている。
- **kill switch**（env / workspace 単位でミラーを止める）がない。B は two-way door なので必須。
- **観測**（push p95、mirror 失敗率、skip 率）が acceptance にない。D106 の見直し条件を測れない。
- **repo 名の codec** がない。workspaceId が Artifacts の命名規則（先頭英数、2〜63、`. _ -`）を満たす保証がない。
- 修正: 0246 を adapter（repo/token/push/status）に絞り、0249（観測・kill switch・ローカルシミュレータ）を分ける。repo 名は `ArtifactsRepoName` codec を 0243 か 0246 に置く。

### B4. token が永続化される危険（0243）

- `MirrorTarget` に token があり、`CheckpointRecord` に入ると DO / D1 / ログに残り得る。
- 修正: `MirrorTarget` は**一時型**、`CheckpointRecord` は `mirror: MirrorState` だけを持つ。token を保存しない型分離と redaction test を 0243 に足す。

### B5. 32MiB / 64MiB の skip 判定ができない（0243 / 0246）

- `CheckpointRecord` に `packBytes` と `maxBlobBytes` がなく、0246 の「32MiB/file または 64MiB/push で skip」を実装できない。
- 修正: `checkpointRun` の結果に `packBytes` / `maxBlobBytes` を足し、`CheckpointRecord` に保存する。skip は push 前に決める。

### B6. mirror の状態遷移が未定義（0243 / 0246）

- pending / mirrored / skipped / failed の関係、再送、失敗からの復帰が書かれていない。
- 修正: 遷移表を定義する。例: pending → mirrored（終端）/ skipped（終端）/ failed → pending（再試行可）。mirrored は不変。

## 2. 直した方がよい点

- **0243 の core 分割**: checkpoint / mirror と review read を `core/src/checkpoint.ts` に同居させない。`core/src/review.ts` に `ReviewCommit` / `ReviewTreeEntry` / `ReviewFile` を分ける。
- **0244 の touches**: `packages/workspace/src/checkpoint.ts` と `packages/workspace/package.json` は変更不要の可能性が高い。契約を狭める。
- **0244 の timeout**: checkpoint は git + pack で長い。machine の 1 リクエスト deadline と pack upload の deadline を分ける。
- **0245 の ack 順序**: R2 → DO は維持。mirror は ack の後に非同期で行い、失敗しても ack を戻さない。
- **0246 の token TTL**: 600 秒は 64MiB push で足りない可能性。900〜1800 秒にするか、push 前に再発行する。
- **0246 の cleanup**: workspace 削除時の repo 削除をやるか、明示的に「やらない」と書く。
- **0247 の R2 fallback**: Worker で pack を index するのは重い。manifest 方式（A'）か、fallback は machine にする選択肢を比較する。0247 の scope が大きい。
- **0248 の design pending**: `design-ref` は pending の間は「候補」でよいが、0232 の UI 設計が決まるまで着手しない。
- **U-01 の形式**: 仮説 / 影響 / 責任者 / トリガーを全 issue で揃える。0244 / 0245 / 0246 / 0247 に責任者がない。
- **BOARD**: matrix は 80 だが内訳（設計待ち 2 / 順番待ち 17 / 依存待ち 59）は 78 のままで、並行作業の追加分が反映されていない。issue 追加時に再集計する。

## 3. 推奨する修正順

1. 0243: `CheckpointPackTransport`、`packBytes` / `maxBlobBytes`、`MirrorTarget` と `MirrorState` の分離、遷移表、`core/review.ts` 分割。
2. 0244: binary pack endpoint の契約（signed / content-type / 64MiB / timeout）を追加。
3. 0245: `MachineFiles` に binary send を足す（または transport interface 経由）。
4. 0246: adapter に絞り、repo 名 codec・kill switch・metrics は 0249 に分離。
5. 0247: GraphQL を外し、service のみ。
6. 0248: GraphQL + UI の唯一の所有者にする。

## 4. 判定

**現状のまま 0243 を now に上げない**。B1〜B6 を 0243/0244/0245 に反映してから開始する。0247 は GraphQL を外せば 0243 と並列に流せる。

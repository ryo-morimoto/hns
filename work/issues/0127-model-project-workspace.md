# 0127: Project と Workspace root の関連

status: open
priority: next
design: agreed
design-ref: D080
depends-on: 0033, 0047, 0145, 0146, 0159, 0198
touches: packages/core/src/types.ts, packages/core/src/graphql/, packages/store/src, packages/store/test, packages/server/src, packages/server/test, packages/web/src/app/, packages/web/test/

## Goal

Project を単なるラベルではなく、1つの workspace root と agent の cwd に結びつける。
UI のプロジェクト切替が、実際に別のファイル空間を開くようにする。

## Acceptance criteria

- [ ] Project に workspace root / agent cwd を持たせる（core / store / API）
- [ ] root は許可された親配下に正規化。symlink / .. / 別ユーザーの path を拒否
- [ ] 既存 project は現行 root を指す migration。不明な root は fail closed
- [ ] 会話作成・Agent 起動・file API が project の root を使う
- [ ] project 切替で workspace / conversation / editor の対象が変わる
- [ ] テスト: 正規化、拒否、migration、別 project の分離

## Notes

- 0109 の Project / Task 画面と 0104 のプロジェクト切替が使う
- マルチマシン（0044）はまだ。root はローカルパス
- 危険な path を UI から自由入力させない。許可 root の選択肢から選ぶ

## Design（D080 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D080）。A2 は暫定で、実装時に問題が出たら A1 へ再判断する。

### 前提

- Worker は fs を持たない。fs / exec はマシン（0147）が ROOT の中で行い、経路は 0157。
- D049: 1 workspace = 1 Session + 1 Workspace DO。`SESSION_NAME = "default"` は「edge が workspace id を知らない」暫定（`session-name.ts` の TSDoc）。
- Workspace DO は `idFromName(workspaceId)` で、最初の acquire が workspaceId と machineId を束縛する（0156）。
- Project はいま id / name だけ。conversation は projectId を持つ。マシンはまだ（0147 レビュー中）。

### 決定案 1: Project = workspace

- 1 Project = 1 Session DO + 1 Workspace DO。DO 名 = projectId（既定 project は "default"）。
- project 切替は DO と WS の対象を変える（`/ws?project=<id>`）。
- 存在しない projectId で DO を作らない。Worker が D1 で存在を確かめてから `idFromName` する。空の project に DO を作らない。
- 最初の acquire で machineId と root を束縛し、違う組み合わせは拒否する（0156 の claim と同じ）。
- 根拠: D049 の「1 workspace = 1 Session」、`SESSION_NAME` の暫定コメント、root ごとに Journal / lease / 版を分ける 0156 の形。
- 代替: 1 Session DO のまま、`env(target)` で会話ごとに root を組み立てる。WS / resolver は変えずに済むが、root の取り違えが1か所のバグで漏れる。hard isolation を優先して per-project を推す。

### 決定案 2: root はマシン ROOT からの相対 POSIX パス

- `Project.workspace_root: string`。`""` はマシン ROOT そのもの（既定 project）。
- 絶対パスは持たない。マシンが変わっても同じ意味になる（0044 に耐える）。
- API の lexical 検査: 先頭 `/` なし、`..` / `.` / 空 segment / `\` / NUL / `.hns` segment を拒否、長さ 255、segment 64。これは早期拒否と UX のためで、**security 境界ではない**。
- 実体検査はマシン: 0157 が ROOT と projectRoot を別々に受け、ROOT を dirfd で開いて解決する。`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`（Linux 5.6+）か、各 component を `O_PATH|O_NOFOLLOW` で walk する（`O_NOFOLLOW` は最終要素にしか効かない）。失敗は `root_not_found` / `root_outside` / `root_symlink` の typed failure（UI の文言が変わる）。
- これで「許可された親配下」は「マシン ROOT 配下」になり、「別ユーザーの path」は絶対パス拒否で消える。

### 決定案 3: root は作成時に固定

- `createProject(name, workspace_root)` の1回だけ設定。変更は 0127 で扱わない（必要になったら「移動」issue）。
- 理由: DO 名・会話メタデータ・agent の cwd・Journal の root 同一性（`.hns/root.json`）が root に紐づく。後から変えると既存の会話・版・Journal の意味が変わる。
- 既存 project の migration: `workspace_root = ""`（現行の ROOT）。不明な root は無い（相対 + "" は常に lexical に有効）。マシンに無い root は使用時に fail closed。

### 決定案 4: API と GraphQL

- `Project` に `workspace_root` を足す（core types / store schema / 次の migration（0149 の後なら 0004）/ SDL）。
- `Mutation.createProject(name, workspaceRoot)` を 0198 の最初の実例にする（Query は既存の projects のまま）。
- 0109 は root を自由入力させず、0125 の tree からディレクトリを選ぶ（0125 の後）。
- `ensureDefault` は "" で作る。

### 決定案 5: 会話と agent の root

- 会話作成時に Worker が project の root を D1 から引き、Session DO の RPC に渡す。DO は会話メタデータに `workspaceRoot` を保存する（内部、公開 Conversation には出さない）。
- DO の `env(target)` は会話メタデータの root から ExecutionEnv を組み立てる。root は固定なので、再起動・再送でも同じ。
- 0147 / 0157 の実 fs は 0157 が差し込む。0127 は fixture の env で「会話の root が env に渡る」ことをテストする。
- file API（0125 / 0157）は Worker が project の root を引き、Workspace DO に渡す。

### 決定案 6: マシン ROOT と project root の関係

- マシンの ROOT は**許可親**。project root は ROOT からの相対パス（決定 2）。
- Worker は `projectRoot` と `path` を**別々に**送る。結合・正規化・実体検査はマシンが行う（レポート R3）。マシンは ROOT を dirfd で開き、`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` か component walk で解決する。project root が symlink なら `root_symlink` で拒否する。
- 失敗は `root_not_found` / `root_outside` / `root_symlink` / `path_outside` に分ける。
- 単一リポジトリで使うときは、マシンの ROOT をそのリポジトリにして project root を `""` にする（既定 project と同じ）。複数 project は ROOT を親にして `projects/<name>` を切る。
- 0148 の Machine に ROOT は持たせない（ROOT はマシンのローカル設定。Worker は相対パスだけを送る）。
- 申し送り: 0147 の ROOT は「project のルート」ではなく「許可親」。0157 のリクエストは `projectRoot` と `path` を別々に持つ。0147 / 0157 が単一 ROOT = 単一 project を前提にしているなら、この issue で契約を拡張する（0147 のレビューで確認）。

### 決定案 8: sandbox と egress（レポート R4–R6）

- sandbox は `--ro-bind / /` の後に `--tmpfs <ROOT>` を置き、project root だけを bind する。**兄弟 project を見せない**。`<projectRoot>/.hns` も tmpfs で隠す。
- hide は呼び出し側の任意リストではなく、**マシン設定の固定リスト**: `~/.config/hns`、`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.git-credentials`、`~/.netrc`、マシン鍵、cloudflared token。
- egress は project 単位の方針を持つ（U-06）。既定は `inherit`（マシン設定）。untrusted は `deny`（`--unshare-net`）または domain allowlist。少なくとも private range と `169.254.169.254` を遮断する。承認 UI が無い間は、egress を開ける project を明示的に選ばせる。
- checkpoint（0154）から `.hns`・secret・`.env` を除外する（0154 への申し送り）。
- `--new-session` を足す（TIOCSTI 対策）。bwrap の引数は `packages/workspace/src/sandbox.ts` の1箇所。
- 申し送り: 0194（sandbox / hide）と 0154（checkpoint）はこの方針に合わせる。

### 決定案 7: 触るものと依存
- touches: `core/src/types.ts`, `core/src/graphql/`, `store/src/{schemas,migrations,repositories}/`, `server/src/{graphql,do,session-name,edge}/`, `web/src/app/`, tests。削除済みの `core/src/http.ts` / `schemas.ts` は消す。
- 依存に **0159**（WS に project を足す。touches が重なる）と **0198**（createProject の Mutation）を足す。0147 / 0157 は依存にしない（fixture で契約を証明）。
- 0198 の AC の「最初の実例は 0127（root 更新）」を「Project の作成（root 付き）」に直す。

### 調査（2026-11-17、進行中）

- 内部モデルとデータ構造: `work/scratch/0127-internal-model.md`（完了。13 図 + 照合表、F1–F5）
- sandbox / VM / bash の既存設計: `work/research/agent-sandbox-designs.md`（完了。12 製品 + OS 6 件、R1–R8）
- U-01 / U-02 / U-03 はこの2つを見て決める。図は「実装済み / planned / 未確定」を分ける。

レポートの要点: 隔離は信頼単位に合わせる（per-project）/ root は相対でマシンが結合・実体検査（openat2 か component walk）/ root は不変 / **兄弟 project を tmpfs で隠す** / hide はマシン固定リスト / **prompt injection → exec → egress が最大の残存リスク**。

### 統合判断（model-map の F1–F5、2026-11-17）

**F1（最重要）: conversationId は DO ローカル**

- pi-durable の id は 1 DB 1 カウンタ（conversation / entry / task / document で共有）。D1 の `conversations.id` は全体 PK、GraphQL の global id は `Conversation:<id>`（0177）。
- per-project DO にすると、project A と B の「会話 2」が同じ D1 行・同じ global id になる。
- 回避策:
  - **A1**: 公開 `Conversation.id` を `<projectId>:<localId>` にする。**`ConversationIdSchema` は permissive（regex なし）なので codec は変えずに済む**。D1 PK / global id の形 / 0149 はそのまま。DO が open 時に projectId を受け、`toConversation` で composite を作る。
  - **A2（採用、暫定）**: D1 の PK を `(project_id, id)` にし、global id は `Conversation:<projectId>:<localId>`。model の id はローカルのまま。migration / 0149 の索引 / 0176 / 0177 が変わる。実装時に問題が出たら A1 へ再判断する。
  - **C**: 中央採番（pi-durable の storage を包む）。侵襲が大きく、採らない。
- **A2 を採る（暫定）**。A1 は fallback（codec / D1 / 0149 不変）。B は project を信頼境界とみなさない場合だけ。

**F2: workspaceId に発番者が無い**

- `workspaceId = projectId` を契約にする（専用 `workspaces` テーブルは作らない）。Workspace DO の最初の acquire が machineId と root を束縛する（0156 の claim）。

**F3: machine の write と封じ込め**

- machine の op は health / stat / read / list のみ（write は 0157）。封じ込めは親 `realpath` + 最終要素 `O_NOFOLLOW` で、案 6 の「ROOT を dirfd で相対全体」ではない。
- 0147 は landed 済み。R3（`openat2` / component walk）は machine の変更が要るので、0147 の follow-up か 0194 に送る。0157 は write を足すときに同じ解決を使う。

**F4: root の二重管理**

- D1 の `Project.workspace_root` を**正本**、会話メタデータの root は**作成時の写し**（INV-11 と同じ扱い）。
- 既存会話は root 未設定 → 次の send で Worker が project root を渡し、DO が埋める（backfill）。doc の `version` は上げず optional で足すか、`migrate` を書く。
- **A（per-project DO）なら不要**（DO ごとに root が固定）。

**F5: 0198 の AC**

- 0198 は「root 更新」、0127 は「作成時固定 + `createProject`」。U-03 の決定後に 0198 の AC を `createProject` に直す。

### U-01 の fork（project は信頼境界か）

| 案 | 中身 | id | 強さ | コスト |
| --- | --- | --- | --- | --- |
| **A** per-project Session DO | DO 名 = projectId。root は DO ごとに固定 | F1 の **A2**（暫定。問題があれば A1） | 構造で分離 | D1 PK の migration / 0149 改訂 / 0176 / 0177 / server / agent。DO 数 = project 数 |
| **B** 単一 Session DO + 会話ごとの env root | 1 DO に複数 project。project ごとに Workspace DO | 変更なし | テストで分離（構造ではない） | exec の root 取り違えが残存リスク |

- **決定（user）**: project を信頼境界とみなす（将来 untrusted な project を持つ）。A を採る。
- A2 を暫定で採る。問題が出た時点で A1 へ再判断する。
### A2 と B の変更点（ファイル単位）

| 変更 | A2（per-project + `(project_id, id)`） | B（単一 DO + 会話ごと env root） |
| --- | --- | --- |
| core / GraphQL | `views.ts` が `projectId + ":" + id` を global id に。`resolvers.ts` と web は last `":"` で split し、project を検証。model の id はローカル | 変更なし |
| D1 / store | `conversations` の PK を `(project_id, id)` に。migration、repo の get / list、parse | 変更なし |
| 0149 の索引 | D080 改訂（PK / keyset を `(project_id, id)` に。rebuild は DO ごと） | 変更なし（D078 のまま） |
| Session DO 名 | `projectId`。`session-name.ts` / `edge` / `graphql/context.ts` / `/ws?project=` | `default` のまま |
| 会話メタデータ | 変更なし（DO ごとに root 固定）。既存会話は id ローカルのまま | 内部 `workspaceRoot` を足し、`env(target)` で per-conversation に組む。既存会話は backfill |
| Workspace DO | `workspaceId = projectId`（0156 / 0157） | 同じ（project ごと） |
| 0198 | `createProject` | `createProject` |
| tests | 同じローカル id の 2 project、global id の split、D1 get の scope、route、backfill | 2 project の root 混在、既存会話の backfill |
### 決定（D080）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | Project = workspace（per-project DO）か | **決定（user）**: A（per-project）。将来 untrusted な project を持つ | 0159 / 0176 / 0149 | 2026-11-17 |
| U-02 | root は相対か絶対か | **決定（user）**: マシン ROOT からの相対（R2 / R3）。結合と実体検査はマシン | 0147 / 0157 | 2026-11-17 |
| U-03 | root の変更 | **決定（user）**: 固定（R7）。移動は新 project + 新 DO + コピー | 0109 | 2026-11-17 |
| U-04 | 0127 の受入範囲 | **決定（user）**: model / API / DO 名 / 会話メタデータ / fixture まで。実 fs は 0157 | 0147 / 0157 | 2026-11-17 |
| U-05 | 依存に 0159 / 0198 を足すか | **決定（user）**: 足す。0159 は WS、0198 は createProject | 0159 / 0198 | 2026-11-17 |
| U-06 | egress 方針を 0127 に含めるか | **決定（user）**: `Project.egress`（`inherit` / `deny` / `allowlist`）を 0127 で足す。既定 `inherit`、untrusted は `deny`。執行は 0147 / 0194 | 0147 / 0194 / 0157 | 2026-11-17 |
| U-07 | A を選ぶ場合の id | **決定（user / 暫定）**: A2（`(project_id, id)` + global id に project）。問題が出たら A1 へ再判断 | 0177 / 0149 / 0176 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | createProject("a", "projects/a") → GraphQL → `workspaceRoot` が返る | 高 | 受入1 |
| C2 | 不正な root（`/abs` / `../x` / `a//b` / `a\\b` / `a/./b` / `.hns/x` / 256 文字）→ invalid_argument、行は増えない | 高 | 受入2 |
| C3 | 既定 project は root "" → file API はマシン ROOT、会話の DO 名は "default" | 高 | 受入3・4 |
| C4 | project a と b → 会話の DO 名と file API の root が分かれ、混ざらない | 高 | 受入5 |
| C5 | 既存 DB を migration → 既存 project の root は "" | 中 | 受入3 |
| C6 | マシンが root_not_found → typed failure、書き込みなし | 中 | 受入2・4 |
| C7 | project 切替 → WS の URL と resolver の DO 名が変わる | 中 | 受入5 |
| C8 | `npm run check` | 高 | 受入6 |
| C9 | project root "projects/a" と path "x" を別々に送る → マシンが結合・解決し、"projects/a/x" だけを開く。`../` と中間 symlink は `root_outside` / `root_symlink` で拒否 | 高 | 受入2・4 |
| C10 | project a の sandbox → 兄弟 project b のファイルが読めない（`--tmpfs <ROOT>`） | 高 | 受入2 |
| C11 | hide の固定リスト → `~/.ssh` / `~/.aws` / マシン鍵が読めない。呼び出し側で追加・削除できない | 高 | 受入2 |
| C12 | egress `deny` → sandbox から外へ出られない。`inherit` はマシン設定に従う | 高 | U-06 |
| C13 | A: project A と B の会話 2 → D1 の行と global id が衝突しない（A1 / A2 のどちらでも）。B: 2 project の会話の env root が混ざらない | 高 | F1 |
| C14 | machine の write → R3 の解決（ROOT + projectRoot + path）を使う。中間 symlink / `..` を拒否 | 高 | F3 |

層は store の unit（migration / lexical）、server の unit（DO 名 / resolver / createProject）、web の unit（切替）、integration は migration と fixture env。実マシンの fs は 0157 が持つ。

## Log

- 2026-11-17: 設計案を追加（レビュー待ち）。
- 2026-11-17: U-04 / U-05 を決定。U-01〜U-03 は内部モデル図と sandbox 調査で判断する（subagent: model-map / sandbox-research）。
- 2026-11-17: 設計レビューで合意（D080）。U-01 = A（per-project）、U-02 = 相対、U-03 = 固定、U-06 = egress を追加、U-07 = A2（暫定）。`design: agreed` にした。
- 2026-11-17: sandbox レポート（work/research/agent-sandbox-designs.md）を受けて R1〜R7 を決定案に反映: per-project、マシン側の結合・実体検査、兄弟 project を tmpfs で隠す、hide の固定リスト、egress は U-06。
## やらないこと

- リモートマシンの root
- Git リポジトリの自動作成

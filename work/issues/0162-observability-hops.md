# 0162: 観測（相関 ID を全ホップに通す）

status: in-progress
priority: next
design: agreed
design-ref: docs/observability.md, D082
depends-on: 0145, 0147
touches: packages/server/src/obs/, packages/core/src/observability.ts, packages/core/src/index.ts, packages/core/src/types.ts, packages/core/src/observability.test.ts, packages/machine/src/log.ts, packages/machine/src/log.test.ts, packages/machine/src/agent.ts, packages/machine/src/index.ts, packages/machine/test/support/machine.ts, packages/machine/test/integration/agent.test.ts, packages/server/src/edge/{handler.ts,handler.test.ts,worker.ts,worker.test.ts}, packages/server/src/do/{session.ts,session.test.ts,session-rpc.ts,session-rpc.test.ts,session-cost.test.ts}, packages/agent/src/{events.ts,session.ts,session.test.ts,agent.ts}, tools/obs/trace.mjs, packages/server/test/integration/obs-cli.test.ts, docs/observability.md, deploy/limits/RESULTS.md, work/issues/0162-observability-hops.md

## Goal

障害箇所が6段（browser / edge / DO / tunnel / agent / fs）に増えるので、1つの ID で追えるようにする。

## Acceptance criteria

- [ ] 相関 ID を browser → Worker → DO → agent → fs まで通す
- [ ] `/api/events`・`/api/metrics` を提供する（docs/observability.md）
- [ ] イベントの語彙を core に閉じた union で置く
- [ ] 本文・ヘッダ・トークンをログに残さない（パスと status だけ）
- [ ] DO のログと agent のログを同じ形で読める
- [ ] 「どこで詰まったか」を1コマンドで出せる
- [ ] 保持期間と量の上限

## Design

2026-11-17 / 実装前。対象は `server/src/obs/`、`core/src/observability.ts`、`machine/src/log.ts`。

### 語彙とログの形（core）

- ホップは `OBS_HOPS = ["browser", "worker", "do", "agent", "fs"]` の const array + union。
- ログは `ObsLogEntry` 1つ。server（DO）と machine は同じ型・同じ JSON line を書く。
  フィールドは `v` / `at` / `level` / `event` / `hop` / `requestId` / `path` / `status` / `durationMs` / `detail` だけ。
- イベント名は既存の `EVENT_NAMES`（core の const array + union）を拡張して使う。追加するのは
  `do.rpc`（DO の内部 RPC）と `fs.op`（machine の fs 操作）の2つだけ。理由: DO の内部 RPC と machine の
  read/stat/list/health は既存の `http`（公開面）でも `file.write`（書き込みの結果）でも `tool.call`
  （agent のツール）でもない。1つの名前で hop と op を detail に持たせると、trace の hop 判定が曖昧になる。
  `http` / `tool.call` / `tool.result` / `agent.response` は既存の名前を使う。語彙の置き場は
  `core/src/types.ts` の1箇所のまま（observability は import するだけ）。`AgentEvent` は agent の
  フックの語彙で、名前は同じ `EVENT_NAMES` を指す。`FILE_EVENT_KINDS` は workspace のファイル監視の
  語彙で、`fs.op` とは別（監視イベントではなく1要求の結果）。統合しない理由をここに残す。
- `detail` は `OBS_DETAIL_KEYS` の allowlist だけ。allowlist 外のキー（`body` / `headers` / `token` など）は
  書き出し時に落とす。path は URL の pathname だけにし、クエリ・フラグメントを落とし、長さを上限で切る。
- `formatObsLog` は既知のキーだけを決まった順で JSON にする。`parseObsLog` は valibot で往復を検査する。
  未知の hop / event / level は `ValiError`（既定値に落とさない）。

### 相関 ID の伝搬

- 0145 の `x-request-id` を再利用する。新しい ID は作らない。
- browser → Worker: inbound が形式に合えばそのまま使い、応答にも返す（0145 の経路）。
- Worker → DO: `/ws` と同じく、`/api/events`・`/api/metrics`・内部 RPC の転送ヘッダに同じ値を載せる。
- DO → agent: Session RPC の `x-request-id` を `session.send` の `requestId` に渡す（body の `requestId` が優先）。
  `agent.response` に `requestId` を載せ、DO が `ObsLogEntry`（hop `agent`）として記録する。本文（`text`）は記録しない。
- agent → fs: machine の受信ヘッダ `x-request-id` をそのまま使い、`fs.op`（hop `fs`）に path / status / duration を書く。
  Worker から machine への署名付き要求にこのヘッダを載せるのは 0148 / 0157。0162 は受信側の契約を固定する。
- **`x-request-id` は署名対象にしない。** 0147 の署名は machineId / connection / seq / timestamp / nonce /
  method / path / bodyHash だけを覆う。相関 ID は認証に使わず、改ざんされても拒否理由にならない
  （0147 の契約を変えない）。このことを `machine/src/log.ts` の TSDoc と issue に明記する。

### 保管（D049 / D053）

- イベントは Session DO の SQLite（`obs_events` 表）に置き、D1 に複製しない。DO が実行中の状態を持ち、
  一覧はその DO から読む。
- 1 ワークスペース 1 Session DO（D049）なので、イベントの単位も同じ。複数 project の DO 分割（D080）が
  入ったら、イベントの読み出しも project ごとになる（この issue では default の 1 DO）。
- 保持は 30 日、件数は 5000 件を上限とし、append 時に上限を超えた分を1文で削除する。保持の削除は
  256 回の append ごとに1回。API の `limit` は 1..500。
- 会話 RPC（`/rpc/conversations/...`）は `do.rpc` を別に書かない。ターンの DO ホップは
  `agent.response`（同じ requestId）で表し、1ホップを二重に数えない。このため text 1 ターンの DO 行は
  9 → 10（`agent.response` 1 行）になり、`session-cost.test.ts` と `deploy/limits/RESULTS.md` を更新した。
- 書き込み失敗で会話・HTTP を止めない（観測は副作用）。ただし破損した行を読んだときは `ValiError` で落とす。

### REST 面（D059）

- `GET /api/events?limit=&level=&since=&requestId=` と `GET /api/metrics` を同じ変更で足す。
- 認証は session cookie。未認証は 401、GET 以外は 405、`SESSION` 不在は 503。schema は `server/src/obs/api.ts` の
  valibot で、`limit` / `level` / `since` / `requestId` の不正は 400（`problem` の `invalid_request`）。
- 応答は `{ ok: true, events }` / `{ ok: true, metrics }`。`cache-control: no-store`。
- 0145 のルーティングに足す。`/api/events` / `/api/metrics` 以外の `/api/*` は 404 のまま。

### 「どこで詰まったか」の 1 コマンド

- `node tools/obs/trace.mjs <requestId>`。`HNS_URL` と `HNS_SESSION_COOKIE` を環境変数で受ける。
- `/api/events?requestId=...` を読み、hop ごとに時系列で出し、最後に観測できた hop と欠けた hop を出す。
  `--expect <hop>` を付けたとき、その hop に届いていなければ exit 1。
- 手順は [docs/observability.md](../../docs/observability.md) に書く。

### やらないこと（設計上の線）

- 外部送出（OTel / Prometheus）と可視化 UI。
- browser 側の JS（web パッケージ）。browser は `x-request-id` を送る契約だけ。
- 0148 / 0157 の Worker → machine の発信側。
- イベントの D1 索引。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 有効な `x-request-id` 付きの要求 → Worker → 応答と DO への転送が同じ id。不正値は捨てて UUID を生成 | 高 | 受入1、0145 |
| C2 | 任意の HTTP 要求（401 / 404 / 200 を含む）→ Worker が `http` を 1 件記録。path はクエリ無し、status と duration を持ち、body / header / token を持たない | 高 | 受入1・4 |
| C3 | DO に 3 件 append → list は新しい順。level / since / requestId で絞れる。limit は 1..500 に clamp | 高 | 受入2 |
| C4 | Session RPC の `x-request-id` 付き send → agent の `agent.response` が同じ requestId を持ち、text を持たない | 高 | 受入1・5 |
| C5 | 署名付き machine 要求に `x-request-id` → `fs.op` が同じ id・pathname・status を持ち、content / body / token を持たない。path は `a.txt` / `/a.txt` / `\a.txt` のどれでも `/a.txt` | 高 | 受入1・4・5 |
| C6 | `/api/events` / `/api/metrics` → cookie 無し 401、GET 以外 405、`SESSION` 無し 503、不正 query 400 | 高 | 受入2、D059 |
| C7 | 未知の hop / event / level を持つ行 → parse が `ValiError`。語彙は core の const array と一致 | 中 | 受入3 |
| C8 | `body` / `headers` / `token` を余分に持つ entry、allowlist 外の detail → format 後の行に現れない | 高 | 受入4 |
| C9 | 30 日より古い行 → append で削除。上限 5000 件を超える append → 最古が消え 5000 件。定数はテストで固定 | 高 | 受入7 |
| C10 | worker / do / agent はあるが fs が無い trace → 「stopped after: agent」を出し、`--expect fs` は exit 1 | 高 | 受入6 |
| C11 | 同じ entry を server の formatter と machine の formatter で書く → 同じ JSON line になり、parse で往復 | 中 | 受入5 |
| C12 | 全変更 → `npm run check` → exit 0 | 高 | Result |

テストしない条件:

- browser の実 JS からの送信（理由: web パッケージは 0162 の touches 外。契約は C1 の edge で固定する）。
- Worker → machine の実発信（理由: 0148 / 0157。machine は受信側を C5 で固定する）。
- 実 workerd / cf dev の DO 永続（理由: 0156 / 0146 と同じく、SQL と schema は実 SQLite の unit が証明し、
  workerd 固有の差は deploy dry-run と既存の cf integration に任せる）。

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 契約（往復） | unit | `server/src/edge/handler.test.ts` "a valid inbound request id is reused and an invalid one is replaced" |
| T2 | C2 | ユースケース | unit | `server/src/edge/handler.test.ts` "the edge records one http event with a path and a status" |
| T3 | C3 | 状態遷移 + 境界値 | unit（実 SQLite） | `server/src/obs/store.test.ts` "events are listed newest first and filtered" / "a limit is clamped" |
| T4 | C4 | 契約 | unit | `server/src/do/session-rpc.test.ts` "the request id reaches the agent event" + `agent/src/session.test.ts` "a send reports the request id without the text" |
| T5 | C5 | 契約 + 故障注入 + 同値分割（先頭区切り） | integration | `machine/test/integration/agent.test.ts` "the request id and the path are logged without the content"（`a.txt` / `/a.txt` / `\a.txt`） |
| T6 | C6 | デシジョンテーブル | unit | `server/src/edge/handler.test.ts` "the observability API requires a session and only GET" + `server/src/obs/api.test.ts` |
| T7 | C7 | 同値分割 | unit | `core/src/observability.test.ts` "an unknown hop, event, or level is refused" |
| T8 | C8 | 故障注入（禁止キー） | unit | `core/src/observability.test.ts` "body, headers, tokens, and unknown detail keys never reach the line" |
| T9 | C9 | 境界値分析 | unit（実 SQLite） | `server/src/obs/store.test.ts` "retention deletes old rows and the cap keeps the newest"（定数は `OBS_RETENTION_DAYS` / `OBS_MAX_EVENTS` の exact 値） |
| T10 | C10 | ユースケース | integration（child process） | `server/test/integration/obs-cli.test.ts` "the trace command names the hop where the request stopped" |
| T11 | C11 | 契約（往復） | unit | `core/src/observability.test.ts` "server and machine lines are the same shape" |
| T12 | C12 | ゲート | static / build | `npm run check` |

## Notes

- 0028 の events 集約を引き継ぐ。**0039 を吸収（D082）**。面（`server/src/obs/`）はこの issue が持つ。

## やらないこと

- 外部への送出（OTel 等）。
- メトリクスの可視化 UI。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: 実装開始。## Design / ## テスト条件 / ## テスト設計 を追加し、status: in-progress。
  touches を拡張（edge / DO / agent / machine / core 語彙 / CLI / docs / コスト実測）。
- 2026-11-17: core に `ObsLogEntry`・ホップ/詳細の閉じた語彙・`formatObsLog` / `parseObsLog` / `obsPath` を追加。
  `EVENT_NAMES` に `do.rpc` / `fs.op` を追加。edge に `/api/events`・`/api/metrics`（session 認証）を足し、
  HTTP イベントを Session DO に fire-and-forget で送る。DO は `obs_events` に保存し、agent の
  `agent.response` / tool イベントを同じ形で記録する。machine は `fs.op` を JSON line で書く。
  `tools/obs/trace.mjs` と docs/observability の手順を追加。`npm run check` は実装後に確認する。
- 2026-11-17: 実装完了（review 前）。HEAD 219d195（コードは 2cdd5d7）。`npm run check` exit 0
  （112 test files / 643 tests、lint / fmt / typecheck / test / build / deploy / knip すべて ok）。
  commit: core 語彙 / agent の requestId / server obs / edge / DO / machine / CLI / docs。
- 受入の証拠:
  1. 相関: `edge/handler.test.ts`（inbound 再利用・不正値の置換・DO への転送）、`edge/worker.test.ts`
     （`/api/events` の x-request-id 転送）、`do/session-rpc.test.ts`（ヘッダ → session.send）、
     `agent/src/session.test.ts`（agent.response の requestId）、`do/session.test.ts`（DO と agent の
     同一 requestId）、`machine/test/integration/agent.test.ts`（fs.op の requestId。署名対象外）。
  2. API: `edge/handler.test.ts`（401 / 405 / 503 / 転送）、`obs/api.test.ts`（query 400・形・no-store）、
     `obs/store.test.ts`（一覧・metrics）。
  3. 語彙: `core/observability.test.ts`（OBS_HOPS / EVENT_NAMES / unknown の ValiError）。
  4. redaction: 同（body / headers / token / detail allowlist）、`obs/log.test.ts`（agent text を捨てる）、
     `edge/handler.test.ts`（onResponse に query/body が無い）、`machine/test/integration/agent.test.ts`
     （file content が line に出ない）。
  5. 同じ形: `core/observability.test.ts`（server / machine line の同型）、`machine/src/log.test.ts`。
  6. 1 コマンド: `server/test/integration/obs-cli.test.ts`（`--expect fs` で exit 1、「stopped after: agent」）。
  7. 保持/上限: `obs/store.test.ts`（30 日 / 5000 件 / limit 500 / open 時 prune / 256 append ごと prune）。
- 実測の更新: text 1 ターンの DO 行は 9 → 10（`agent.response` 1 行。会話 RPC は `do.rpc` を二重計上しない）。
  `deploy/limits/RESULTS.md` と `do/session-cost.test.ts` を更新。
- 未確認 / 先送り: browser の実 JS（web は touches 外。edge の契約で固定）、Worker → machine の発信
  （0148 / 0157）、実 workerd の obs 表の長期動作（SQL は実 SQLite の unit と cf dev の既存 integration）、
  runId を持つ hop（0162 のどのホップも runId をまだ持たない。trace は detail にあれば出す）。
- review は未実施。issue は done にしない。
- 2026-11-17: reviewer-0162 が BLOCKED（blocking 1 / 低 8）。blocking は machine の fs ログで、先頭 `/` 付きの
  有効な path（`/a.txt`）に `"/"` を足して `//a.txt` にし、URL がホストとして解釈して pathname が
  `/` になっていた。`normalizeRelative` を第一候補にし、拒否される path は先頭区切りを落とす
  best-effort に変更（ログの失敗でリクエストは落とさない）。C5/T5 に `/a.txt` と `\a.txt` を追加。
- 低も修正: trace は自分の `x-request-id` を送らない（自己ログ防止）、失敗したターン（400/429/503）は
  `do.rpc` を残す（成功して agent イベントを書いた時だけ skip）、SESSION 不在の `/api/metrics` 503 テスト、
  docs の ID 発番の記述を「edge が HTTP ID、内部 runtime は自分の turn ID を生成し得る」に弱め、
  fire-and-forget の消失と metrics が下限であることを docs / RESULTS に明記。
- follow-up（低 4 / 5 / 7）: 語彙・allowlist・request-id regex の二重管理、CLI テストの fake API、
  tool イベントの requestId。いずれも 0162 の受入には影響しないが、次の観測変更で寄せる。


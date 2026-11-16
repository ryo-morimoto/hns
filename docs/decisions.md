# Decisions

追記専用の決定ログ。新しいものが下。変更は新しいエントリで置き換え、置き換えたことを書く。

## D001: Pi Durable 1.5.0 を固定し、ExecutionEnv を境界にする

date: 2026-11-06 · by: coordinator · issue: -

`pi-durable` / `pi-env` / `pi-ai` を **1.5.0 exact pin**。Agent の実行と永続化は借り、
ファイルの安全（`expectedVersion` / Journal / 認可 / イベント）は Workspace 層が持つ。
ExecutionEnv に条件付き書き込みが無く、組み込みツールの直列化もプロセス内限定だったため
（[実測](../work/research/pi-durable-1.5.0.md)）。Durable の内部 Storage・クラスには結合せず、
組み込みの `write`/`edit` は本番の Agent に使わせない。

代替案: Durable をフォークして CAS を足す / Agent Runtime ごと自作。どちらも上流追従か
再実装コストの面で不利。上流が CAS を提供したら、この層を薄くする。

## D002: リポジトリ構成（README / ARCH / docs / work）

date: 2026-11-06 · by: coordinator · issue: -

README は「やりたいこと」、ARCH はアーキテクチャ、docs はコンポーネント・レイヤー別の仕様、
work は作業（BOARD・issues）と調査・PoC（research・poc）。docs はネストさせずフラットに置く。
提供資料の原文は work/research に置き、書き換えない。

## D003: MVP は 1マシンで「会話→編集→差分→再開」

date: 2026-11-06 · by: user · issue: -

最初の実用範囲は 1 マシン。セルフホスト起動、会話、権限つきファイル編集、差分、再開までを通し、
2マシン接続は M3 に送る。要件#2 の配置（A/B）は [topology.md](topology.md) で比較中。

## D004: マシン側は A（中央 + pi-env/SSH）で開始する

date: 2026-11-06 · by: user · issue: -

責務を10に分けた結果、MVP で効くのは接続・認証・セットアップ・資格情報の4つだけで、どれも exec で足りる。
常駐サービスとポートは A では無理だが MVP の対象外（[分解](topology.md)）。
前提: 対象マシンへ到達できる / git・gh・tooling は既に設定済み / sudo と対話は人手。
A'（常駐 Agent）に上げる条件は、マシン初期化・資格情報管理・常駐サービスを製品機能にするとき。

## D005: Agent の Tool は Workspace と sandbox を経由する

date: 2026-11-06 · by: user · issue: 0007

組み込みの `read`/`write` は使わず、`read_file`/`write_file` を自前で登録して Workspace の版チェックを通す。
`bash` は `createBashTool` を sandbox（`createSandboxEnv`）越しに動かす。
組み込み Tool は `api.env` を直接触るため、条件付き保存も root 封じ込めも通らない。

## D006: 次は Editor、Provider は鍵が来てから

date: 2026-11-06 · by: user · issue: 0008

MVP の受入は「会話→編集→差分→再開」。会話は faux で通ったので、次は人間側の編集を成立させる。
実 Provider（U-05）は API 鍵がこの環境に無く、検証できないため後回しにする。
Editor は Workspace の競合契約を人間の操作で確かめる場でもある。

## D007: 最初の実 Provider は Ollama Cloud

date: 2026-11-06 · by: user · issue: 0012

`https://ollama.com/v1`（OpenAI 互換）を `openai-completions` API で使う。既定モデルは `gpt-oss:120b`。
鍵は `~/.config/hns/ollama.key` か `OLLAMA_API_KEY`（リポジトリには置かない）。
`qwen3-coder:480b` は退役していたため使わない。正式な OpenAI / Anthropic / Google は鍵が来たら足す。

## D008: 2つ目の Provider は OpenCode Go

date: 2026-11-06 · by: user · issue: 0013

pi-ai の `opencode-go` プロバイダをそのまま使う。鍵は `~/.config/hns/opencode-go.key`。
`openai-completions` と `anthropic-messages` でツール呼び出しを確認。Google 系（`gemini-4-argon`）は設定で無効化中のため未確認。
Provider ごとに「API 方式が通る」と「モデルが使える」は別なので、モデル追加時は両方確かめる。

## D009: 統合 MVP は単一プロセス + SQLite + ポーリング UI

date: 2026-11-06 · by: user · issue: 0014

会話（Durable）・ファイル（Workspace）・UI を1プロセスに載せる。保存は Durable の SQLite。
進捗はまず1秒ポーリングで足りる。ストリーミングは必要になってから足す。
これで MVP の「会話→編集→差分→再開」が1マシンで成立した。

## D010: 進捗は SSE、未完了タスクは inspect から

date: 2026-11-06 · by: user · issue: 0015

D009 のポーリングを `GET /api/stream`（SSE）に置き換える。送信の起点は Durable の `conversation.watch`。
未完了タスクは `harness.inspect` から取り、transcript と同じスナップショットに載せる。
`/api/state` は残す（テストと初期表示の保険）。

## D011: UI は最後。最終段で UX に集中する

date: 2026-11-06 · by: user · issue: -

いまの UI は機能確認のための最小（会話・ファイル・diff・タスク）。作り込みは最終段に回す。
そのときは、見た目より「迷わない・戻れる・待ちが分かる」を基準に、まとめて詰める。
それまでは API と型を先に固め、UI の都合で境界を曲げない。

## D012: Workflow は当面サーバ内で逐次実行する

date: 2026-11-06 · by: user · issue: 0017

グラフの検証と版管理は先に固め、実行はサーバ内でトポロジカル順に1ノードずつ回す。1ノード = 1会話。
Durable のタスクに載せた再開可能な実行は、ノード種別と副作用の扱いが決まってからにする。
落ちた run は起動時に `interrupted` とし、勝手に再実行しない。

## D013: Automation は Firing だけ持ち、実行は Workflow に委譲する

date: 2026-11-06 · by: user · issue: 0018

trigger は webhook（token 付き URL）と schedule（5 フィールド cron、ローカル時刻）。
action は workflow / chat / task。実行状態は Automation に持たせず、Workflow Run と Firing に残す。
同時実行は Automation ごとに 1 つ、重なった分は `skipped`。落ちた実行は再試行しない。

## D014: アプリの入口は token、既定は loopback

date: 2026-11-06 · by: user · issue: 0019

`HNS_TOKEN` か state の `token`（0600）を使う。API は Bearer / query / cookie を受け、無ければ 401。
Webhook は Automation ごとの token で動き、アプリ token を要求しない。既定の bind は 127.0.0.1。
UI は `?token=` で受け取って `sessionStorage` に置く。複数ユーザーと RBAC はまだ無い。

## D015: バックアップは VACUUM INTO、復元は停止中に

date: 2026-11-06 · by: user · issue: 0020

動いている間に取れる一貫したスナップショットとして `VACUUM INTO` を使う。`journal.json` と `token` はコピー。
復元はアプリを止めて行い、`-wal` / `-shm` を消してから置き換える。
`control.sqlite` は `user_version` でスキーマ版を持ち、変更はそこに足す。

## D016: tailnet の ID を認証に使う

date: 2026-11-06 · by: user · issue: 0021

`auth: "tailscale"` のとき、接続元 IP を `tailscale whois` で引いて LoginName を取る。
許可リストで絞り、whois が失敗したら拒否。ループバックは既定で拒否（`HNS_ALLOW_LOCAL=1` で許可）。
`tailscale serve` のヘッダは信じない。passkey は設計だけ残し、ブラウザ認証器が要るので後回し。

## D017: passkey は WebAuthn + セッション cookie

date: 2026-11-06 · by: user · issue: 0022

登録・ログインは WebAuthn（`@simplewebauthn/server`）。credential は Control Plane に保存し、ログイン後はサーバ発行の `hns_session`（HttpOnly、30日）で通す。`auth: "passkey"` で切り替え。ブラウザの認証器は Playwright の仮想オーセンティケータでテストする。

## D018: 秘密は user / service のスコープに分ける

date: 2026-11-06 · by: user · issue: 0024

`user` は人の秘密、`service` は Automation とバックグラウンド実行の資格情報。AES-256-GCM で保存し、Automation 側は `getService` だけを使う。`user` は将来 PRF で包む。

## D019: PRF で包み、ログイン中だけ復号する

date: 2026-11-06 · by: user · issue: 0023

登録時にブラウザで DEK を生成し、PRF 出力から HKDF で作った KEK で包んで保存する。
ログイン時に開いてセッションに渡し、平文の DEK はメモリだけに置く。再起動・ログアウトで消える。
`user` の秘密はロック中 `423`。`service` はサーバ鍵なので Automation は動き続ける。

## D020: 1つの DEK をパスキーと復旧コードで包む

date: 2026-11-06 · by: user · issue: 0025

`user_keys` に包みを複数持つ。登録時に PRF（HKDF）と復旧コード（PBKDF2 600k）の2つで包む。
ログイン時は PRF で開ける包みを順に試し、開けたらセッションに渡す。復旧コードはサーバ側で開いて
セッションを作る（コード自体が資格情報）。誤りは 401。

## D021: 2台目のパスキーは unlocked セッションで追加する

date: 2026-11-06 · by: user · issue: 0026

`/api/passkey/add/options` と `add/verify` は unlocked のセッションだけを受け付ける。
ブラウザは `/api/passkey/dek` で DEK を受け取り、新しい認証器の PRF で包み直して追加する。
既存の包みは消さない。DEK を返すのは unlocked の間だけなので、XSS は境界を破れる点に注意。

## D022: 制限はアプリ層でかけ、中断は conversation.abort

date: 2026-11-06 · by: user · issue: 0027

レート・予算・タイムアウトは Durable の設定ではなくアプリ層で判定する。
利用量はターン終了時に `usage` の差分を `usage_log` に残す。
中断は `abortSubmission` では実行中のターンが止まらなかったため、`conversation.abort` を使う。
予算超過は実行中のターンを止めず、次のターンから 429。

## D023: 観測は events テーブルに集約する

date: 2026-11-06 · by: user · issue: 0028

HTTP・会話・中断・例外を `events` に残す。クエリ・ヘッダ・本文は記録しない（token を落とさない）。
`x-request-id` で相関し、`/api/events` と `/api/metrics` で読む。30日で削除。
時系列の保存や外部送出（OTLP/Prometheus）は必要になってから。

## D024: 会話は論理削除、root は消さない

date: 2026-11-07 · by: user · issue: 0029

会話は `deleted_at` で隠す。Durable の transcript は `session.sqlite` に残し、アプリからは見せない（物理削除の API が無い）。
root 会話は削除できない（アプリの起点）。検索はタイトルのみ（本文検索は必要になってから）。
一覧は `updated_at` の新しい順で、送信・完了のたびに更新する。

## D025: sandbox は検出して fail closed

date: 2026-11-07 · by: user · issue: 0030

起動時に bubblewrap を `--version` と user namespace の実行使で検出し、使えなければ bash ツールを登録しない。
`/api/health` に理由を出す。`.git` は読み取りのみ。rename の前後でパスを再確認し、外れたら `unknown`。
復旧コードは同一 login で 5 回失敗したら 15 分止める。SSH は pi-env のフラグを検査済み（実接続は未）。

## D026: 技術スタックを固定する

date: 2026-11-07 · by: user · issue: 0031

TypeScript strict / Node 24 / Fastify / SQLite / React + Vite + CodeMirror 6 / Vitest + Playwright / **oxlint + oxfmt** + vendored anti-slop / **npm workspaces**（pi の packages 構成に倣う）。理由と棄却した選択肢は [engineering.md](../docs/engineering.md) §1。

## D027: 型が正本（type first）

date: 2026-11-07 · by: user · issue: 0031

`packages/core/src/types.ts` が唯一の正本。実行時の検証層と API 定義書は持たない。
UI とサーバは types.ts の型だけを使う。スキーマを先に書かない（型を二重に定義しない）。

## D028: AI slop はゲートで止める

date: 2026-11-07 · by: user · issue: 0031

noUncheckedIndexedAccess、vendored anti-slop（18 ルール。require-readable-spacing は oxfmt と衝突するため無効）、tsc --noEmit、oxfmt --check、knip、依存追加の ADR 必須、生成コードの明示、PR 1目的、TODO の issue 必須。エージェントの成果物も同じゲートを通す。詳細は [engineering.md](../docs/engineering.md) §4。

## D029: パッケージは 6 つで始める

date: 2026-11-07 · by: user · issue: 0032

core / workspace / agent / store / server / web。apps は作らず packages に置く（pi の coding-agent に倣う）。
providers は agent の中、identity は store の ./identity、Workflow と Automation は server の中。
状態の所有者と依存方向は [packages.md](../docs/packages.md)。育ったら orchestrator 等に切る。

## D030: 型は不変条件を持つパッケージに置く

date: 2026-11-07 · by: user · issue: 0032

`core` は公開モデル（2つ以上のパッケージが使い、ワイヤーで約束するもの）だけ。Row 型は `store`、
実行中の内部状態は `agent`、ファイル操作の内部型は `workspace` に置く。1パッケージしか使わない型は core に置かない。
`@hns/store` の Row 型と変換から実装を始めた（`packages/store`）。brand は `ProjectId` と `ConversationId` のみ。

## D031: 境界は valibot、エラーはコード、遷移は1箇所

date: 2026-11-07 · by: user · issue: 0032

- HTTP の入口と DB の読み出しは valibot で parse する（`packages/core/src/schemas.ts`・`packages/store/src/schemas.ts`）。
- API のエラーは `ErrorCode` の union（`ErrorResponse { code, message }`）。
- Workflow / Automation の状態は const array 由来の union。遷移は `packages/core/src/workflow.ts` の表だけ。
- SQLite はコンテナ不要。実 SQLite（インメモリ/ファイル）でテストする。外部サービスが増えたら testcontainers。

## D032: Node 24 を flake で固定する

date: 2026-11-07 · by: coordinator · issue: 0004

Node は 24.x（nixpkgs `nixos-25.11` の `nodejs_24`、いまは 24.18.0）に固定し、`flake.nix` と
`flake.lock` で nixpkgs の rev ごと固定する。`scripts/with-node.sh` は `nix develop` 経由で
同じ Node を実行し、PATH の node や `/nix/store` の glob（旧実装）は使わない。D026 の
「Node 24」を再現可能にするための決定で、22.x は選ばない（`node:sqlite` の挙動を 24 に揃える）。
flake を使えない環境では Node 24.18 以降を PATH に置く。CI での利用は 0041。

## D033: exec は Linux の bubblewrap だけで提供し、他は出さない

date: 2026-11-07 · by: coordinator · issue: 0006

起動時に bwrap の所在（`BWRAP` / PATH）・バージョン・user namespace を、wrapper と同じ引数の実実行で確かめる。
通らなければ exec を提供しない（生の exec にも、警告だけにもしない）。`/api/health` に
`{ exec, code, reason, version, userNamespaces }` を出し、bash ツールとワークフローの tool ノードを止める。
macOS の sandbox-exec と Windows の AppContainer は実機で検証できるまで実装しない
（[調査](../work/research/sandbox-platforms.md)）。bwrap は 0.12.0 で検証し、下限は設けず毎回の probe で実効性を見る。

## D034: TOCTOU は openat2 ではなく exec する helper で閉じる

date: 2026-11-07 · by: agent · issue: 0005

pi-env 1.5.0 の daemon はパスしか受けない（protocol に fd 相対の操作が無い）。足すのは pin した外部パッケージの
fork になり、macOS / Windows はさらに別 API になる。そこで `rooted.mjs` を exec で 1 操作 1 プロセス起動し、
`/proc/self/fd/<dirfd>/<name>` 経由の openat 相当で解決・再ハッシュ・rename をまとめて行う。
Linux 以外・exec 無し・helper が届かないホストでは従来の再確認にフォールバックし、`Workspace.mode` で区別する。
代替案: daemon に operation を足す（上流 fork）/ 独自 Worker（配布と起動コストが増える）/
Node の `fs` だけで解決（daemon 越しに fd を渡せない）。上流が fd 相対の操作を出したら helper を捨てる。

## D035: Node 26（最新系列）へ上げる

date: 2026-11-07 · by: coordinator · issue: 0004

D032 の Node 24 を 26.x に置き換える。nixpkgs の入力を `nixos-25.11` から `nixpkgs-unstable` に変え、
`flake.lock` で rev（いまは Node 26.13.0 / npm 11.20.0）まで固定する。26 は現行の最新系列（偶数版・LTS）。
25 は upstream EOL で nixpkgs からも削除済み、24 は保守のみ。`node:sqlite` と `node --test` の
型ストリップは 26 でも同じで、ゲートと PoC は通った。最新へ上げ直すときは `nix flake update nixpkgs`
→ `scripts/with-node.sh npm run check`（lock を更新するまで再現性は保たれる）。

## D036: workspace は core のファイル DTO を借り、helper はパッケージ同梱のプログラムとして exec する

date: 2026-11-07 · by: agent · issue: 0033

`@hns/workspace` の `read` / `write` は `/api/file` の DTO（`FileRead` / `MutationResult`）をそのまま返す。
同じ形を二重に定義すると必ずずれるので、定義は `core` に置き、型だけ `workspace → core` を許す（実行時の依存は無い）。
Journal・intent・dirfd の protocol は workspace の内部型として workspace に置く。

dirfd の helper（0005 / D034）は、ビルドすると `dist/rooted-helper.js` になる独立したプログラムとして同梱する。
呼ぶ側は `import.meta.url` の隣の `rooted-helper.ts`（source 条件）か `.js`（dist）を選ぶ。
exec できない環境・Linux 以外では helper を諦めて `mode: "checks"` の経路に落ちる（保証の差は `Workspace.mode` で見える）。

## D037: agent の失敗は値で返し、できる操作は型で分ける

date: 2026-11-07 · by: agent · issue: 0034

ツールの拒否（`denied` / `conflict` / `unknown`）は例外ではなく JSON の値でモデルに返す。1 つの拒否で run を落とさず、
モデルが読み直して直せるようにするため（[typescript.md](typescript.md) §3）。想定外の失敗（defect）はそのまま投げる。
`ShellAccess = sandboxed | disabled` で「exec を出せるか」を型にし、`disabled` のときは bash ツールを登録しない
（生の exec に落ちる経路を作らない。0006 / D033）。依存（storage / models / workspace / shell）は `openAgent()` だけで受け取り、
import 時に接続しない。永続 storage（再起動をまたぐ resume）は store 側の実装（0035）で差し替える。

## D038: テストは Vitest 1本と node:assert、層は5つ

date: 2026-11-07 · by: coordinator · issue: 0046

D026 の Vitest を維持し、node:test から移行した（124 tests）。Vitest 5.1.0 を exact pin し、
`vitest.config.ts` の `projects` でパッケージを分ける。層は unit / contract / repository / API / E2E。
永続化はモックせず実 SQLite、HTTP は `fastify.inject`、E2E は Playwright だけ。
アサーションは `node:assert/strict` に統一し、`expect` は使わない。flaky はリトライしない。
Trigger.dev / Medusa / Twenty / Payload / Effect の層分けを参考にした（[testing.md](testing.md)）。

## D039: 会話ランタイムは pi-durable 一択とし、pi-agent-core は採用しない

date: 2026-11-07 · by: user · issue: 0034

pi-agent-core 1.5.0 は版が揃っていて（pi-ai / pi-schema は同一の exact pin）、実測では Workspace のツールと sandbox を
そのまま載せられた（[work/poc/pi-agent](../work/poc/pi-agent)、12/12）。ただ機能差は「実行場所の差」で、サーバ常駐の
我々の構成では使わない。pi-agent-core の固有機能は proxy.ts（クライアントから LLM 呼び出しをサーバ経由にする）、
素のループ API（agentLoop / runAgentLoop / runToolCall）、thinkingBudgets、onProviderStreamEvent で、いずれも
ループをクライアントで回すための道具立て。それ以外は Durable に対応物がある（subscribe → Conversation.watch + pi.live、
text_delta → partial commit、steer/followUp → whenBusy / steeringMode / pi.inbox、convertToLlm → beforeRequest、
beforeToolCall → ToolHooks）。逆に Durable にしかないもの（耐久・checkpoint・compaction・タスクグラフ・拡張レジストリ・
usage 台帳・subagent 会話の所有権・commit 単位の watch）は要件に直結する。

前提が変わる条件: web 側でループを回す（オフライン編集＋ローカル推論など）なら、proxy と素のループが採用理由になる。
それまでの delegate（外の会話から一発の副作業を切り出す）は Durable の子会話で行う（[compare.mjs](../work/poc/pi-agent/compare.mjs) の B）。
agent-core in durable（同 C）は採らない。

## D040: 実装後は独立レビューを1回通し、直した diff も再レビューする

date: 2026-11-07 · by: agent · issue: -

`npm run check` は型・整形・テストの整合しか見ない。2026-11-07 のレビュー3回で、ゲート緑のまま
root 外への任意書き込み（C-1）と watcher の未処理 reject（C-2）が出た。レビューは任意ではなく、
実装の一部として通す。判断原則は [AGENTS.md](../AGENTS.md) の Review、手順と判定は [review.md](review.md)、
不変条件は [review/](review/)。判定は PASS / FAIL / BLOCKED、blocking は**この変更で生まれた**重大・高・中。
低は blocking にしない。前からある問題は diff が悪化させた場合だけで、再現も経路の提示もできない指摘は blocking にしない。
指摘として成立するかは再現か経路で決まり、blocking かは重大度と provenance で決まる。

直しも同じだけ危ない。1回目の修正で、自分の wire schema に違反する operationId と、文字単位で
JSON を壊す上限を入れ、どちらも次のレビューでしか見つからなかった。さらに同じ検査を2層に置き、
呼び出し元の無い helper を足した（`aa88d58` / `d71faf7` で削除）。だから修正 diff は同じ reviewer に
再 review させ、規則は1箇所、回帰テストは「直す前のコードで落ちる」ことを条件にする。
観点は [review/](review/) にだけ持ち、lint・型で機械化できたものは表から消す。
対象と除外は [process.md](review/process.md)（対象外は Result に1行）。

採用しなかったもの: 確信度の数値閾値（指摘として成立するかは再現か経路で決まり、数値はその代理にならない）、常設の検証エージェント
（blocking は reviewer が反証を1回試してから出す）、レビューの速さ・礼儀の規範（blocking は重大度と provenance で決まり、
速さは判断材料にならない）、観点表の「安全な代替」列（代替は観点表の確認列と AGENTS の規約にあり、列を増やすと重複する）。

前提が変わる条件: ゲートか CI が同じ観点を機械的に見るようになったら、その観点を表から外す。
review が重くて作業を止めるなら、blocking の下限を上げる（中を外して重大・高だけにする）か、対象を
「契約・安全・永続化に触る変更」に狭める。

## D041: レビューを 原則・手順・不変条件の3層に分け、不変条件は条件で読む

date: 2026-11-07 · by: agent · issue: -

D040 の観点表は1ファイル 113 行・約 9KB になり、reviewer は変更と無関係な観点（認可・永続化・互換）まで
毎回読んでいた。観点を足すほど悪化するので、3層に分ける。

- **原則**は [AGENTS.md](../AGENTS.md) の Review。常に文脈にある。
- **手順と判定**は [review.md](review.md)。reviewer が毎回読む（3.8KB）。
- **不変条件**は条件別の [review/](review/)。常に common（1.7KB）と、変更が触る領域だけ（security / persistence
  各 1.3KB、contracts 0.9KB）。観点の採否は eval（0.9KB、変更時だけ）。
- **進行と記録**は [process.md](review/process.md)（2.0KB）。author が読む。reviewer には渡さない。

reviewer の最小の読み込みは約 7KB（review.md + common + 1領域、実測 6.8KB。従来 約 9KB）。領域が2つなら約 8KB で、
全領域と process まで読むと従来を超える。総量は約 12KB でファイル境界の分だけ増える。
旧「入力が外へ出る」は security（値が外へ出る）と contracts（入口の網羅）の2行に割った。
代わりに、観点を足しても review.md と common は増えない。D002 の「docs はフラット」はこのディレクトリだけ例外にする
（読む単位が条件で決まるものは、ファイルも分ける）。

前提が変わる条件: reviewer を skill / サブエージェント定義にするなら、手順はその定義に移し、docs は不変条件だけにする。
領域ファイルが2画面を超えたら条件をさらに割る（1ファイル = 1つの条件）。reviewer の読み込みが 1 ファイル版を上回ったら、
分割をやめて戻す。

## D042: 設計判断とレビュー観点には原典リンクを付ける

date: 2026-11-07 · by: agent · issue: -

設計の原則は文献に由来する。しかしどれが原典でどれが hns の統合判断かを区別しないと、根拠のない規則が増える。
[design.md](design.md) に設計の規律を領域ごと（抽象化 / 境界 / 契約 / 状態 / HTTP / セキュリティ）に
「条件 → 命令 → 補足 → Ref」の形で置き、Ref には原典のリンクを貼る（番号だけの索引にしない。読みに行くコストを
見積もって行動が変わらないため）。AGENTS.md の原則とレビューの観点表も、同じ原典リンクで参照する。

設計時は abstraction（今必要か）→ boundary（何を隠すか）→ contract（公開面）→ data（状態）→ http / security の順に読み、
レビュー時は各観点の Ref 列から辿る。原典と統合判断の区別（2回で抽象化、blocking の定義、優先度を作らない）は
design.md と各項目の補足に書く。

## D043: Web UI を画面単位で前倒しする（contract-first / fixture 併用）

date: 2026-11-07 · by: user · issue: 0036

D011 の「UI は最後」を、ユーザー判断で前倒しする。PoC で Agentic Workspace の Intent と Golden flow を検証でき、画面単位で本実装へ移せる見通しが付いた。型・検証・サーバを固める順序は変えないが、Web は core の HTTP 契約（0037）に接続し、0035 の完成前は fixture client で画面とテストを進める。

- packages/web は React 19.3.1 + Vite 8.3.6 + TanStack Query 5.106.1。依存は exact pin。
- HTTP は @hns/core の ROUTES / parseResponse だけを使い、response 型を手書きしない。
- 画面: workspace → conversation → editor → settings / auth → project-task / workflow / automation。
- 0100 foundation → 0101 design system → 0102 shell → 0103–0112 screens/components → 0113 responsive/a11y → 0114 visual review → 0036 integration → 0043 E2E。
- 0100 の依存 pin: react 19.3.1 / react-dom 19.3.1 / @tanstack/react-query 5.106.1 / vite 8.3.6 / @vitejs/plugin-react 6.2.1 / @types/react 19.3.0 / @types/react-dom 19.3.0 / @testing-library/react 16.3.3 / @testing-library/user-event 14.6.8 / jsdom 31.0.0。
- CodeMirror 6 は 0106 で exact pin と理由をこの decision に追記する（engineering で選定済み）。
- API / data の不足は 0115–0131 に分離（overview / WorkItem / ack / live SSE / conversation GET / evidence / search / provider / settings / backup / file tree / notifications / project root / OAuth / run cancel / workflow archive / automation archive）。
- UI の Intent は work/poc/app/ui/INTENT.md を引き継ぐ。PoC は履歴として残し、機能追加はしない。
- server 0035 が未完成の間、実サーバー接続を前提にした受け入れは fixture と契約テストまで。E2E は 0043。
- 技術選定の参考として X の記事（[Rebuilding the global town square from scratch](https://blog.x.com/en/engineering/rebuilding-the-global-town-square-from-scratch), 2026-11-04）を採る。Vite 8（Rolldown）/ React 19 / TypeScript strict / named export と barrel なし / 境界での parse / jsdom + Testing Library の方針を共有する。
- Relay + GraphQL と SSR / streaming は採らない。hns の契約は core の ROUTES による typed REST で、読者は自己ホストの認証済み利用者だけ（crawler / link preview を分ける必要がない）。
- プリミティブは Base UI（`@base-ui/react` 1.9.0、exact pin）を土台にする（0101）。CSS は CSS 変数のトークンのままで、Tailwind は入れない。未使用の依存を 0100 に足さないため、追加は最初の部品を作る 0101 で行う。
- 0100 の web 依存のうち typescript / @types/node / valibot は既存 workspace と同じレンジ（^ 始まり）、受入条件に列挙した 10 依存は exact pin。

## D044: 型検査は tsrs（Rust 版 tsc）で行う

date: 2026-11-07 · by: user · issue: 0100

X の記事（2026-11-04）に倣い、`npm run check` の型検査を [tsrs](https://github.com/oxc-project/tsrs) 0.22.0-ts7.1.0-beta（TS 7.1 の Rust 実装）に置き換える。速さとメモリが目的で、検査の意味は変えない。

- 各パッケージの `typecheck` は `tsrs --noEmit`。ゲートでは `--fast` を付けない（既定モードが TS 7.1 の checker 挙動を保つ）。
- 宣言の emit（`tsc -p tsconfig.build.json`）は TypeScript 5.9 のまま。tsrs は検査専用にし、emit の置き換えは必要になってから別 issue にする。
- tsrs が未対応の構文で落ちたときは tsc に戻す。ゲートを止めない。
- 既存 4 パッケージと web の型検査が tsrs で通ることを確認して切り替えた。

## D045: 調査・要件・技術選定の進め方を docs/process.md に置く

date: 2026-11-07 · by: agent · issue: -

工程の判断（何を作るか、どこまで決めて進むか、何を買うか）が会話と issue に散っていて、後から前提を辿れなかった。
[process.md](process.md) に、段階と出口、ゲート判定（Go / 条件付き Go / Limited Go / Hold）、未確定の状態と台帳、
調査の手順（問題文・三層・代表1件の比較）、全体像（体験・概念・システム）、技術選定（変更コスト×不確実性、買う→借りる→作る、
試作と実用の区別、決定と保留の記録）を置く。設計の判断は design.md、実装後の検証は review.md、決定は decisions に残す。

hns: ゲートは会議ではなく、issue と decisions に残る判定として運用する。未確定は issue の `## 未確定` に書き、
高リスクは関連作業の着手前に見直す。既存品で足りるなら作らない（YAGNI / PAGNI の判断は design.md と共通）。

前提が変わる条件: 工程が CI やチケットの状態機械で自動化され、ゲート判定が人の判断でなくなったら、この文書は判定基準だけに縮める。

## D046: UI/UX と Agentic Workspace の Golden Example を作業前後の参照に置く

date: 2026-11-07 · by: agent · issue: -

画面の判断が会話と好みで決まり、作業後に見る観点も無かった。[design/interface.md](design/interface.md) に、5つの実例から
抽出した12原則（仕事が主役、委任と所有権、注意の順序、透明性の既定、レビュー面、直接編集、非同期、中断可能性、
入力精度と遅延、頻度、キーボード同等、状態の網羅）を条件・命令・補足・原典リンクで置き、[review/ux.md](review/ux.md) に
作業後の確認と証拠の要件を置く。実例は Linear AIG / Cursor / Manus / Claude Cowork / Replit Agent と、Web UI の15例
（テーマ別に2つずつ）。作業前は interface.md、作業後は ux.md を読み、レビューの索引から UI 変更のときだけ ux.md に届く。

hns: 参考は見た目の模倣ではなく「どの問題をどう解いているか」を1文で残す。好みは blocking にしない。
前提が変わる条件: hns の UI が実装され、画面ごとの独自規範（レイアウト・トークン）ができたら、原則はそちらへ移し、
ここは実例の索引に縮める。

## D047: 正本を Cloudflare に置き、実行は手元に残す

date: 2026-11-07 · by: user · issue: 0140

[work/poc/cf-harness](../work/poc/cf-harness/README.md) で pi-durable 1.5.0 の Harness を Durable Object に載せ、
ツールだけを手元のマシンで実行する構成を通した。実デプロイで 1 op 28ms（p95 61ms）、1 ターン 4 op で 181ms。
75 秒のアイドル後も会話と状態は DO SQLite から戻り、[RESULTS.md](../work/poc/cf-harness/RESULTS.md) に実測を残した。
許容範囲と判断し、**正本を Cloudflare に置く**。

正本の範囲は、Control Plane（Run / Task / Workflow / 版 / 認可）を Durable Objects、ワークスペースの確定内容を R2、
会話を DO 上の pi-durable とする。実行はマシン上のエージェント（cloudflared + 署名付きリクエスト）で、Cloudflare は計算を持たない
（Containers / Computer は採らない）。durable の単位は commit 済み ref（`refs/hns/checkpoints/<runId>`）。
RPO は ack 済み保存 0、agent の shell 変更は Run 終了時まで。版チェックは lease でマシンに委譲し、期限切れは fail closed。
provider 鍵は harness の isolate に置かず gateway Worker が持ち、git の資格情報はマシンに残す。
一覧・検索は D1 の投影、ライブ更新は WebSocket。

hns: 「セルフホスト」は UI とサーバのコードを自分で動かせることを指し、Cloudflare アカウント無しでは会話が動かないことを明記する。
SSH 経路は失われる（DO は生の TCP を張れない）。要件1の意味、D004（A 前提）、D016（tailnet 認証）を置き換える。D039（pi-durable 一択）は維持する。
残る未知は DO の CPU / 128MB と長時間 bash と provider ストリーミングの3つで、0163 と 0152 で測る。

前提が変わる条件: 実運用で p95 が 150ms を超える、DO のメモリ上限に当たる、またはコストが月 $50 を超える。
そのときは ExecutionEnv と Storage の境界でローカルへ戻す（[0166](../work/issues/0166-migration-rollback.md)）。

## D048: 正本の単位は (C, J) とし、ack は単一システムで閉じる

date: 2026-11-07 · by: user · issue: 0141

D047 の「正本を Cloudflare に置く」を、同一性の単位まで下ろした。正本は **`(C, J)`**（最後の checkpoint
commit と、その後の確定済み Journal）。作業ツリーは `C ⊕ J ⊕ U` の写像で、U（未確定変更）は durable でない。
契約は [durability.md](durability.md)。

**Journal は Workspace DO に分ける**（1 ワークスペースに 1 つ）。会話は Session DO が持ち、Workspace DO を
RPC で呼ぶ。寿命と粒度が違い、会話を消しても版を残す必要があるため。

**本文は 256KB まで DO の行に持ち、それ以上は R2 に置いて hash だけ残す。** ack は DO の 1 トランザクションで閉じる。
大きい場合のみ R2 → DO → ack の順。逆にすると「ack したのに R2 に無い」が作れる。

**checkpoint は Run の終了時だけ**（中断・lease 解放・正常終了を含む）。定期的には打たない。この帰結として、
Run の途中でプロセスが死ぬとその Run の未確定変更は丸ごと失われる。

hns: 費用は容量ではなく行数と往復で決まる。月1万保存・8KB なら、DO に本文を置いても R2 に置いても $0 で、
小さいファイルでは DO のほうが安い（行課金 $1/100万 < Class A $4.5/100万、往復も無い）。R2 を使う理由は
金額ではなく 128MB のメモリ上限と復帰時間。本当の罠は token 単位の commit、J を切り詰めないこと、
イベントごとの D1 同期更新、小さな DO の乱造。

前提が変わる条件: 1 保存あたりの本文が常に 256KB を超える、または DO の行数が月 5,000万を超える。

## D049: Durable Object は調整の単位にだけ使う

date: 2026-11-07 · by: user · issue: 0146

Cloudflare の指針（[cloudflare/skills](https://github.com/cloudflare/skills)）に照らすと、D047 の設計は DO を
制御レコードと接続管理にまで広げていて過剰だった。DO は「エンティティ単位の調整が中心」のときに使い、
レコードを SQL で引く用途は D1 にする。

**PiHarness（pi-durable 1.5.0 を DO で動かす）は維持する。** ただし 1 会話 = 1 DO をやめ、**1 ワークスペース = 1 Session** にする
（pi-durable の Session は複数の会話を持つ。ベンダー例も 1 DO に全会話を載せている）。残す DO は次の2種類だけ。

| 種別                    | 単位             | 役割                         |
| ----------------------- | ---------------- | ---------------------------- |
| Session DO（PiHarness） | 1 ワークスペース | harness・transcript・run・WS |
| Workspace DO            | 1 ワークスペース | Journal・版・lease・直列化   |

**D1 に移すもの**: Project / Task / Workflow 定義 / Machine レコード。machine は cloudflared で常時接続を持たないので
DO は要らない（D1 のレコード + fetch）。provider の予算カウンタは D1 の 1 文（`UPDATE ... WHERE spent < limit`）。
automations の起動は Cron Triggers。一覧は D1（会話と run の索引だけを Session DO からミラーする）。

hns: 「実行中の状態は DO、確定したレコードは D1」。D1 に実行中の状態を書かない（正本を2つにしない）。
Workspace DO は残す。高頻度の小さい書き込みと epoch の整合は、単一プライマリの SQL では詰まる。
クラス数が 2 つになることで、migration とデプロイの面も半分になる。

前提が変わる条件: 1 ワークスペースの履歴が DO の 10GB / 128MB に近づく、または D1 の書き込みが
run の記録に追いつかなくなる。そのときは Session を時間やプロジェクトで分割する。

## D050: コミット時チェックはステージ済みのパッケージに限定する

date: 2026-11-07 · by: agent · issue: -

実測（グリーンなツリー、Node 26）で `npm run check` は約 20.3 秒。内訳は test 12.9s（63%）と build 5.5s（27%）で、
lint / fmt / typecheck / knip は合計 1.5 秒だった。直近 133 コミットのうち 94（71%）は `packages/` に触れていない。
つまり待ち時間の大半は、変更と関係のない検査に払われていた。

段階の定義を `tools/gate/stages.ts`、対象の選別を `tools/gate/select.ts` に置き、pre-commit は
`git diff --cached` のパスから影響パッケージ（依存の閉包）を計算して、その範囲だけを回す。
段階は個別に実行でき（`npm run gate <stage>`）、`npm run check` は同じ定義の `--all` にした。
実際に web だけのコミットは 3.95 秒、docs だけなら 0.1 秒で終わる（実測）。

却下: lint-staged / lefthook / prek をこの時点で入れる。どれも npm workspaces の影響範囲を計算せず、
段階分割と選別だけで 7 割のコミットが 0.1 秒になるため、まず効果の大きい部分を依存ゼロで入れる（買う→借りる→作る の順）。
部分ステージの内容（index と作業ツリーの差）はまだ見ていない。ツールは作業ツリーを読むので、
ステージ後に編集したファイルは「検査した内容 ≠ コミット内容」になり得る。必要になったら runner を入れて埋める。

見直す条件: CI（0041）を入れるとき、パッケージが 8 つを超えるとき、または部分ステージの取り違えが実際に起きたとき。

## D051: コミットは速い層、push は全部。層は「プロセス」で分ける

date: 2026-11-07 · by: agent · issue: 0170, 0171, 0172

D050 の続き。hook を pre-commit と pre-push に分け、テストを unit と integration に分けた。
分ける基準は**時間ではなく「1プロセスで終わるか」**にした。遅い unit テストは層の問題ではなくテストの書き方の問題で、
遅いからという理由で integration に逃がすと、直すべきものが見えなくなる（実測: unit 化した workspace は 771ms、
rooted を切ると open 2.7ms / write 2.5ms。遅さの正体は rooted ヘルパーの**操作ごとのプロセス起動**だった。0172）。

実測（Node 26、5パッケージ）:

|                         | 変更前 | 変更後                                    |
| ----------------------- | ------ | ----------------------------------------- |
| pre-commit（docs のみ） | 20.5s  | 0.12s                                     |
| pre-commit（core 変更） | 20.5s  | 2.6s                                      |
| pre-push                | なし   | 20.8s（integration・build・knip 込み）    |
| テスト（unit のみ）     | 12.9s  | 1.66s                                     |
| テスト（全部）          | 12.9s  | 13.3s（integration を足したため件数は増） |

- 層: `packages/<pkg>/test` = unit（対象の操作は in-process、rooted:false。bwrap の有無などの検出は1ファイル1回まで）、`test/integration` = 別プロセス。
  同じシナリオを両方で回すファイルは `*.tiers.test.ts` とし、vitest の project が `inject("tier")` で層を渡す。
- hook: 段階表に `hooks` 列を持たせ、build と knip を pre-push に移した。pre-push は全パッケージ・全段階。
- runner は引き続き自作。prek 0.3.11 を実際に動かして比較したが、**依存閉包を表現できない**（workspace の変更で
  core のフックが "no files to check" になる）。gate を1フックとして包むと、置き換わるのは4行のシェル2本だけだった。
  prek を採るのは「per-file の lint/format と stash が要る」「複数リポジトリで hook 導入を揃える」が出たとき。

見直す条件: integration が 30 秒を超える、または push 前が重すぎて迂回されるようになったとき（そのときは `git diff @{push}` で push 範囲に絞る）。

## D052: フックは prek に通し、ステージ内容と merge をゲートで覆う
date: 2026-11-07 · by: agent · issue: 0174

D051 で残した「部分ステージの内容一致」と「merge の素通り」を埋める。worktree の退避・復元を自作するのは
事故りやすいので、prek **0.5.10**（npm、exact pin）に任せる。

実測（prek 0.5.10）:

| 確認 | 結果 |
| --- | --- |
| staged=B / worktree=C の pre-commit | フックは **B** を見て、終了後に worktree を C に戻す |
| `prek run --stage pre-commit` を .githooks から | 同じ（shim のインストールは不要） |
| pre-merge-commit ステージ | 非 fast-forward の merge でフックが走る |
| 出力 | 既定では成功時に隠れるので `verbose: true` を付けた（段階ごとの時間が消えない） |

構成: `.pre-commit-config.yaml` に3フック（commit / merge / push）。`.githooks/*` は
`prek run --stage <stage>` を呼ぶだけで、`core.hooksPath=.githooks` は変えない。
merge は commit と同じ段階（unit まで）を回し、全量は push が担う。

代償: フックの間だけ worktree が退避される（commit で約2.5秒、pre-push は全量なので約20秒）。
同時に別プロセスがファイルを書くと復元が衝突し得る。pre-commit を短く保つ理由が1つ増えた。

注意: `.pre-commit-config.yaml` を編集して stage しないままだと、prek は「設定が stage されていない」として
**すべてのコミットを止める**（フックはコミットされる設定で走るべき、という安全策）。
フック設定を変えたら、その変更も同じコミットに含める。

見直す条件: prek の更新が止まる、または退避・復元で事故が起きたとき（そのときは lefthook を同じ形で試す）。

## D053: 接続・計算・ライブ更新の言い方を訂正する

（当初 D052 として追記したが、並行作業の D052（フックを prek に通す）と衝突したため D053 に振り直した。）

date: 2026-11-07 · by: agent · issue: 0140

D047〜D049 に、実装者が誤読する言い方があった。本文は残し、ここで上書きする。

- **SSH が使えない理由**は「DO が生の TCP を張れない」ではない。Workers ランタイムは outbound の TCP を持ち、DO も同じ。
  正しい制約は**マシンが NAT / tailnet の内側にあり inbound を受けない**ことで、外向き接続（cloudflared）が要る。
- **「Cloudflare は計算を持たない」**は「ユーザーのワークロード（git / npm / build / test）を実行しない」の意味。
  Harness は DO の上で動く。
- **cloudflared は外向きの接続を維持する**（D049 の「常時接続を持たない」は誤り）。machine の状態を D1 で足りるのは、
  接続の有無ではなく記録の性質による。
- **D010 の「進捗は SSE」は 0159 の WS に置き換える。** 0050 / 0118 と同じ扱い。
- 一覧のために D1 に置くのは**会話と run の索引だけ**。イベントは D1 に複製しない。

hns: 決定は追記で直す。D047〜D049 の本文は履歴として残す。

前提が変わる条件: WS 以外の輸送に変える、または Cloudflare 上でワークロードを動かす決定をしたとき。


## D054: 優先度は now / plan / batch / hold の4つで表し、agent は now だけを着手する
date: 2026-11-07 · by: user · issue: -

open の issue が 87 件フラットに並び、どれを拾うかが agent の判断に委ねられていた。重要でないもの・
すでに新しい設計に吸収されたものも同じ列にいるため、着手の選択がぶれた。

重要度 × 緊急度で4つに分ける。issue の front matter に `priority:`、[BOARD](../work/BOARD.md) の先頭にマトリクスを置く。

| priority | 重要度 | 緊急度 | 意味 |
| --- | --- | --- | --- |
| `now` | 高 | 高 | いまの波。依存が満たされていて、すぐ着手してよい |
| `plan` | 高 | 低 | 重要だが、いまの波の後。レーン順に上げる |
| `batch` | 低 | 中 | 安い・隣接するときだけ。単独では着手しない |
| `hold` | — | — | いまはやらない（Want・保留・新しい設計に吸収） |

**agent が着手してよいのは `now` だけ。** `now` が空なら止まって人に聞く。`plan` を `now` に上げるのは人の判断で、
agent は自分で昇格しない。`batch` は同じファイル・同じレーンを触るついでだけ。`hold` はユーザーが明示したときだけ。

hns: 分類は「重要度＝Must 要件・クリティカルパス・安全」「緊急度＝いまの波を止めているか」で決める。
now は波が進むたびに入れ替わる（いまは L0 / L1 と進行中の 9 件）。

前提が変わる条件: 波が変わり、now が空になったとき（人が plan から上げる）。

## D055: Web の契約を GraphQL、クライアントを Relay にする

date: 2026-11-10 · by: user · issue: 0175–0182

D043 の「Relay + GraphQL と SSR / streaming は採らない」を置き換える。判断材料は
[work/poc/graphql-relay](../work/poc/graphql-relay/RESULTS.md) の実測で、REST と GraphQL を同じデータ層
（DO の live 状態、D1 の確定レコード）に載せて比べた。

- 読みの DO RPC 数はまとめ方で決まり、プロトコルでは決まらない（WS ごと 12、会話ごと 40/120、索引 0）。
- 同一 field set の payload は ±5% 以内。選択を絞ったときだけ差が出る（37〜41%）。
- graphql-js の実行時コストは 0.17ms（DO RPC 28ms の 0.6%）。
- Relay は store が満たせる要求を 0 回にする（実測: 再訪 0、別 operation でも field が揃えば 0）。
- 索引（[0149](../work/issues/0149-d1-projection.md)）を置かない構成でも画面は成立する（mirror 書き込み 0、needs 8/8）。

決めたこと:

- **web のアプリ契約は GraphQL**（`/graphql` 1 endpoint）。SDL は `@hns/core` のモデルから起こし、
  schema-first にしない（型が正本。AGENTS.md）。
- **クライアントは Relay**（`relay-compiler` / `react-relay` / `relay-runtime`）。exact pin は 0178 で決める。
- **REST は残す**。passkey / hooks / health・metrics・usage / machine agent / ファイルのバイト列は GraphQL に載せない
  （プロトコルに縛られた面、または graph の形をしていない面。既存 49 ルートのうち 22）。
- **id は型をまたいで一意にする**。Relay の正規化 store は同じ id を 2 つの型に割り当てられない。
  PoC で `Conversation` と `Item` が同じ id を持ち、Relay が衝突を警告した。
- **codegen をゲートの前段に入れる**（型検査・テストの前に生成）。生成物は手で編集しない。
- **store の鮮度方針を画面ごとに決める**。`store-or-network` は再取得 0 なので、購読か明示的な再取得を
  決めないと古いまま表示される。
- **索引は 0149 の push 型**（DO が commit 後に自分の行を書く）。全件を間隔ごとに pull して書き直す形は採らない
  （実測: 40 会話・1s で $53.68/月、D047 の閾値超え）。

hns: D043 の残り（Vite / React / TanStack Query / Base UI / CSS 変数）は維持する。TanStack Query は
Relay が持たない画面状態と、GraphQL 以外の面（passkey 等）に残す。

前提が変わる条件: Relay の store と DO の正本の整合を説明できなくなったとき、codegen と生成物の同期が
ゲートの支配的要因になったとき、または購読（0159）をスキーマに載せるとメッセージの union が二重化するとき。

0175 の実装で決めたこと（SDL の管理）:

- `graphql` 16.11.0 を core の依存に exact pin。SDL は `@hns/core/graphql` のサブパスから取り、
  ルートの entry からは出さない（web の bundle に graphql-js を入れない）。
- SDL の field 名は明示する。`project_id` → `projectId`、boolean は `is`/`has`（`archived` → `isArchived`）。
  `is`/`has` を付けられない boolean が要るときは、そのとき例外の仕組みを足す（今は無い。`defineEntity` が拒否する）。
- enum の公開名は SCREAMING_SNAKE_CASE、内部値はモデルの literal のまま（`TODO` = `"todo"`）。
- 並びは生成側で決める（型と field は名前順、enum の値は宣言順）。`lexicographicSortSchema` は使わない。
  schema と SDL の成果物が食い違わないようにするため。
- SDL は `buildSdl()` の出力を**コミットする成果物**として web に置く（`packages/web/schema.graphql`、0178）。
  再生成して差分が出たら落とす検査は 0180。手で編集しない。
- 契約の進化: 加算のみ安全。削除は `@deprecated` を1回置き、利用箇所を列挙してから消す。
  enum への値追加は、receiver の `switch` を先に更新する。

## D056: テストのアサーションは Vitest の expect に統一する

date: 2026-11-10 · by: user · issue: 0183, 0184

D038 の「アサーションは node:assert/strict に統一。expect は使わない」を置き換える。
in-source / doctest / 別ファイルを同じ API で書け、ブラウザでも動く。node:assert は本番 import と
TS2775（assertion 関数の分割代入）の制約があり、in-source と相性が悪い。

- テストは `expect` を使う。`node:assert` はテストから外す。
- 型の絞り込みは `defined()` か明示チェックで行い、`as` を増やさない。
- D038 のランナー（Vitest 5.1.0）と unit / integration の分離は維持する。層の呼び名は D057 で整理する。履歴は残す。

前提が変わる条件: `expect` で型の絞り込みが実用にならない、または Vitest 以外の runner に移るとき。

## D057: テスト管理は TSDoc 契約 + コロケート/インソーステスト + doctest にする

date: 2026-11-10 · by: user · issue: 0183–0187

中央カタログと docs の検証表は作らない。テスト要件は issue の `## テスト条件` / `## テスト設計` に書き、
永続する仕様は TSDoc の契約とテストに置く。

- テスト分析: Example Mapping（Story / Rules / Examples / Questions）で受入条件を条件に分解する。
- テスト設計: 条件ごとに技法（同値分割・境界値・デシジョンテーブル・状態遷移・シナリオ・故障注入）と
  最も低い層を選ぶ。同じシナリオを複数層で回さない。
- コード: unit はソースの隣（`src/*.test.ts`）、in-source は小さな純粋関数、公開 API の例は TSDoc の
  `@example` を doctest として実行する。integration / E2E は別ディレクトリ。
- TSDoc の範囲は export する API + 内部の重要な関数。`@remarks` / `@throws` / `@example` を使う。
- テスト/コードから issue を参照しない。コード/テストの TODO にも issue 番号を書かない。
- アサーションは Vitest の `expect`（D056）。
- パッケージのビルドは **tsdown 0.23.7**（Rolldown。dts / treeshake / define）で、`import.meta.vitest` を落とす。
- 公開 API の doctest は **vite-plugin-doctest 3.0.0**（TSDoc の `@example` を Vitest で実行）で行う。

採用しなかったもの: 中央カタログ（二重管理・更新漏れ）、docs の検証表（実行されない・レビューが弱い）、
Gherkin / Cucumber（unit には重く、E2E は Playwright のテスト名で足りる）。

前提が変わる条件: TypeDoc と doctest で要求の抜けを説明できなくなったとき、または
複数チームで監査用の対応表が必要になったとき。

## D058: tiers の二重実行を廃止し、シナリオは1層1回にする

date: 2026-11-10 · by: user · issue: 0185

同じシナリオを unit / integration の両方で回す `*.tiers.test.ts` を廃止する。シナリオは一度だけ、
最も低い層で実行する。workspace は dirfd 経路を integration で1回、local daemon は別のスモークにする。

- `*.tiers.test.ts` / `inject("tier")` / `targetsForTier` を削除する。
- `vitest.config.ts` の `<pkg>` / `<pkg>-integration` は残すが、tiers の include / provide は持たない。
- workspace の共通シナリオは `test/integration` で `node/dirfd` の1ターゲットに固定する。
- local daemon は `test/integration/local-daemon.test.ts` のスモーク1本にする。
- checks モード（rooted: false）の重複は落とす。dirfd の保護は integration で確認する。

前提が変わる条件: ローカル daemon と node で dirfd の挙動が分かれ、片方だけでは回帰を説明できなくなったとき。


## D059: core は「系が合意する語彙」とし、REST は面ごとに実装する

date: 2026-11-10 · by: user · issue: 0188

前案（`@hns/contract` を切り、REST 22 本を残置する）を置き換える。0145 の入口は GraphQL / WS / 静的の3面。

- **`@hns/contract` は作らない。** `@hns/core` の意味を「系が合意する語彙（モデルと、その射影）」にする。
  SDL は `@hns/core/graphql` のサブパス（D055 / 0175 の形）を維持する。SDL はモデルからの射影で独立した
  真実を持たない。独立しているのは公開方針だけで、それは約 250 行の projection であり、パッケージではなく
  サブパスと oxlint で隔離できる。小チームでは、モデル変更のたびに 2 パッケージと「model か wire か」の
  型分類が増える方が高くつく。
- **REST は事前に宣言しない。** 49 本の `ROUTES` と schema、web の typed client / fixture を削除した。
  REST 面は、それを実装する issue が schema・認証・handler を同じ変更で足す。**D055 の「22 本は REST に
  残す」はここで取り消す。** 宣言だけの面は「実装済み・正常」と誤認させ、agent を「残す・増やす」方向に
  推論させる。
- 要求・応答の封筒と運用 view は、その面を実装するパッケージが持つ。永続するモデルと、DO・agent・machine を
  跨ぐ型だけを core に置く。
- 削除した契約のテストは復活させない。面ごとの issue が schema と一緒に足す。

D030（型の置き場所）の「ワイヤーで約束するもの」と、D043 の「ROUTES による typed REST」は、
wire に関する部分をここで置き換える。D043 の UI 側（Vite / React / TanStack Query）は維持する。

前提が変わる条件: REST 面が増えて parse とエラー封筒の重複が痛くなったとき（共通部分を core に戻す）、
または公開面を独立に版管理する必要が出たとき。

## D060: 実行レーンは最大3本にし、増やす条件を固定する

date: 2026-11-10 · by: user · issue: —

同時に流す変更を「変更レーン」として扱い、2本から3本に増やす。D049 のレーン（L0〜L9）は設計の所有単位で、
こちらは実行の単位（1 issue / 1 ブランチ / 1 owner / 1 reviewer / 交わらない `touches`）。同じ語で別の軸を指さない。

- 同時に流すのは最大3本。増やすのは人。agent は自分でレーンを増やさない。
- 3本目は、依存・名前空間・レビュー・統合・契約・隠す手段・戻し方・計測の前提をすべて満たすときだけ開く。
- 統合は一度に1本。rebase → `npm run check` → review PASS → merge → main で再確認。個々に green でも
  結合で壊れる（merge skew）ため、統合後の確認を省かない。
- レーンが外部待ち・依存待ちで止まったら、4本目を足さず、そのレーンを入れ替える。
- レーン数は速度の指標にしない。リードタイム、レビュー待ち、統合待ち、競合、統合後の失敗で見る。
- 詳細と出典は [parallel-change.md](parallel-change.md)。

採用しなかったもの: レーン数を固定の目標にする（ボトルネックを隠す）、issue を跨ぐ共有ブランチ
（merge skew とレビュー単位の曖昧化）、依存が未マージのまま3本目を開くこと（先回りと手戻り）。

前提が変わる条件: レビューと統合が自動化され、待ちがボトルネックでなくなったとき。レーンの寿命が
2日を超える状態が続き、分割で説明できなくなったとき。

## D061: テストの型の絞り込みは expect.assert を使う

date: 2026-11-10 · by: user · issue: 0184

D056 の「型の絞り込みは defined() ヘルパーか明示チェックで行う」を置き換える。`expect(...).toBe...` は
型を絞らないため、テストの絞り込みは `expect.assert(condition)` に統一する。`defined()` ヘルパーは作らない。
`as` は増やさない。

前提が変わる条件: `expect.assert` が使えない runner に移るとき、または複雑な絞り込みで helper が必要になったとき。

## D062: アサーションは expect を主とし、型の絞り込みには node:assert も使う

date: 2026-11-11 · by: user · issue: 0184

D056 の「expect に統一し、node:assert を使わない」と、D061 の「絞り込みは expect.assert のみ」を置き換える。
一般には expect を主に使い、型の絞り込みだけ node:assert / expect.assert で補う。どちらか一方への統一を強制しない。

- 通常のアサーションは expect を優先する（差分・メッセージ）。
- 型の絞り込みは node:assert の assert / assert.ok / assert.equal、または expect.assert(...) を使う。
- node:assert を禁止しない。expect を禁止しない。混在は意図として説明する。

前提が変わる条件: テストのアサーション規約を1つに固定する必要が出たとき、または node:assert と expect の混在が
レビューで説明できなくなったとき。

## D063: 配備は cf の modes と tools/deploy の cloudflare.config.ts で行う

date: 2026-11-11 · by: user · issue: 0144

Worker は cf で配備する。設定は tools/deploy/cloudflare.config.ts、環境は cf の modes で切る。
cf は npm workspace の root では project を特定できないため、tools/deploy を project root にする。

- cf 1.0.0-beta.28 と wrangler 4.156.0 を exact pin。Node 26.13。
  型は既存パッケージと同じ @types/node 24.19.2 を使う（Node 26 の型はまだ使わない）。
- mode は必須（--mode の省略は拒否）。development / staging / production の3モード。
  Worker は hns-dev / hns-stg / hns-prod。
- staging / production は https の HNS_AGENT_URL と HNS_MODEL を必須にする。development だけ既定を持つ。
- 秘密は cf deploy --secrets-file に統一。staging / production は ~/.config/hns/<mode>.secrets.json（0600、JSON）。
  Secrets Store は MVP では採らない（binding と rotate の面が増える。0163 で再検討）。
- cf deploy --dry-run は認証もアップロードも不要。npm run check と pre-push の deploy stage で
  --mode development を実行する。
- cloudflare.config.ts は tools/deploy。0145 までの一時 entrypoint は tools/deploy/worker.ts。
  0145 が tools/deploy/worker.ts を packages/server/src/edge/worker.ts の re-export に差し替える。
- DO は Session だけ。Workspace は 0146 / 0156。
- deploy.sh / config.test.ts / cloudflare.config.ts / worker.ts / tsconfig.json / package.json を
  tools/deploy/ にまとめる。

前提が変わる条件: cf が複数 Worker を1つの config で扱えるようになったとき、Secrets Store に移るとき、
または 0145 が deploy project を packages/server に移すとき。

## D064: store は D1 専用にし、node:sqlite を削除する

date: 2026-11-11 · by: user · issue: 0150

D049 で制御データの正本は D1 と決まった。0047 の `node:sqlite` は D047 / D049 より前の過渡で、製品の利用者は
Worker だけで、Node 側に store を使う機能は無い。二重バックエンドは (1) D1 が拒む `BEGIN` /
`PRAGMA user_version` を node のテストが隠す、(2) sync / async の二重化、(3) migration の版管理の分岐を
生むので、**D1 専用**にして `node:sqlite` を削除する。

- 公開 API は `openStore({ d1, now?, newId? }): Promise<Store>`。全リポジトリと `close` は async。
- D1 に interactive transaction は無い。単文はそのまま、複数文は `batch`（D1 では原子的）で表す。
  migration は `schema_migrations` に版を持ち、schema と版の INSERT を1つの `batch` で書く。
  `PRAGMA user_version` は使わない。
- テストは miniflare の実 D1 SQLite（workerd）で行う。workerd は子プロセスなので store の振る舞いテストは
  integration 層。pure な `parse*` / schema は unit に残す。commit gate は unit だけなので、store の振る舞いは
  pre-push / `npm run check` で走る（workspace と同じ）。
- `miniflare` は store の devDependency に exact pin（5.20261104.0-beta。`cf` が既に lock に持つ版と同じ）。テスト専用。
- 却下: `node:sqlite` をテスト専用に残す（別方言の偽の安心）、両実装の parity テスト（保守対象が増える）、
  better-sqlite3（D1 と共通化できない）、Worker で `node:sqlite` を使う（D1 の binding が正本）。

前提が変わる条件: Node で store を使う製品機能（CLI・バックアップ）ができたとき、または D1 に interactive
transaction が入ったとき。

## D065: CLI は cf に統一し、wrangler を直接使わない

date: 2026-11-11 · by: user · issue: 0146

開発・検証・配備のコマンドは `cf` だけにする。`cf dev` / `cf deploy --dry-run` / `cf deploy` を使い、
`wrangler` コマンドは tests・scripts・docs・手順のどこでも実行しない。

- `wrangler` は cf の Wrangler bundler が内部で必要とするため、tools/deploy の依存には残る。
  これは cf の実装詳細であり、直接の入口ではない。
- `cf dev` の local state は `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` で workspace 内
  （`.work/` / `.cache/`）に置く。`--persist-to` は cf dev が受け付けないため使わない。
  `WRANGLER_LOG_PATH` は使わない。
- gate の deploy stage も cf だけを呼び、`WRANGLER_*` 環境変数を使わない。
- 0145 の Result にあった `wrangler dev` の smoke は無効とし、cf dev で再確認する。

却下: wrangler を開発用の近道として残す（cf と設定・状態・ログの入口が二重になる）、
`WRANGLER_LOG_PATH` を cf の下で使い続ける（cf-only の監査ができない）。

前提が変わる条件: cf が Vite bundler を採用し、wrangler 依存自体を外せるようになったとき。
そのときは 0144 の bundler 選択を見直す。

## D066: 並列の単位をパッケージからファイル（サブツリー）にする

date: 2026-11-16 · by: user · issue: —

D060 の「3本の前提」と [work/README.md](../work/README.md) の並列ルールを、`packages/*` 単位から `touches` のファイル単位に変える。
同じパッケージでもサブツリーが分かれていれば並列にしてよい（例: `server/src/edge/` と `server/src/do/`）。
名前空間の判定は「`touches` の交わり」で行い、パッケージの一致では止めない。

- 共有ファイルは1レーンだけが触る: `package.json` / `package-lock.json`（lock owner）、`packages/server/src/index.ts`、
  `packages/server/src/edge/handler.ts`、`tools/deploy/worker.ts`、`tools/deploy/cloudflare.config.ts`。
- `work/BOARD.md` / `work/LANES.md` は lead が所有する。レーンは触らず、統合のたびに lead が1回で更新する。
- 同じディレクトリに入るレーンは、merge の前に `touches` のファイルが交わらないことを確認する。
- D060 のレーン数（最大3本）・統合の直列化・計測は変えない。

採用しなかったもの: パッケージ単位の直列を維持する（`server` の edge と do が別作業でも待ち、レーンが空かない）、
サブツリー名を固定表で持つ（所有は issue の `touches` で決まるので、表は drift する）。

前提が変わる条件: 同じパッケージ内の意味的な競合（別々に実装した同じ概念）が merge 後に出たとき。
レビューがファイル単位の分割を追えず、レビュー待ちがリードタイムを支配したとき。

## D067: 完了は構造化レコードで表し、Result への追記をやめる

date: 2026-11-16 · by: user · issue: 0195

Result は書かれているが、レビュー・進捗・次回の判断に使われていない。欄を足しても、読む側と形式がなければ同じになる。完了は **1 issue 1 レコード**で表す。形式は YAML とし、置き場とスキーマは 0195 の J1 で決める。レコードは intent / criteria / limits / decision / invalidation / outcome を持つ。

- done level はレコードから導出する。手動で上げる API は作らない。
- 消費者はレビュー・進捗・次セッション・製品の4つ。**消費者がいない欄は作らない。**
- 移行は新規から。過去の issue は遡及しない。
- 記録は issue から辿れることを必須にする（issue の外に置いてよい）。

却下: Result に欄を足す（読む側が増えない）、issue 本文をパースする（形式が自由すぎる）、外部のチケット管理に寄せる（判断の文脈が hns の外に出る）。

前提が変わる条件: 3カ月使って消費者が1つも動かない、またはレコードの維持コストがレビュー時間を超えたとき。

## D068: 四半期のテーゼと Moat 台帳を持ち、成果の層を運用に入れる

date: 2026-11-16 · by: user · issue: 0195

フローの計測（リードタイム、レビュー待ち、統合待ち、競合、ゲート時間、統合後の失敗）は「速く安全に流れているか」を測るが、ユーザーに何が起きたかは測っていない。四半期に work/THESIS.md（未作成。四半期レビューで作る）を1枚作り、Moat 台帳を添える。

- テーゼは WHO / WHAT / WHY US / ACCUMULATES / NOT。
- 台帳は Moat 候補、今期に増えた証拠、投下した時間、次の一手。
- 効率化で浮いた時間を機能追加に全部戻さない。Moat への配分を四半期に決める（目安10%）。
- 週次デモ30分（資料ではなく動くもの）、月次キルリスト（plan から降ろす）。
- 計測は既存に証拠カバレッジ、手戻り率、判断リードタイム、Moat 配分を足す。

却下: BOARD の優先度だけで運用する（成果の層がない）、OKR を別に立てる（四半期1枚で足りる）。

前提が変わる条件: Moat の証拠が2期続けて書けない、またはデモとキルリストが定着しないとき。

## D069: レビューを4層に分け、月次で判断を蒸留する

date: 2026-11-16 · by: user · issue: 0195

レビューを意図・設計・実装・結果の4層に分ける。既存 [review.md](review.md) は実装層の規程として維持する。

| 層 | 主担当 | 成果物 |
| --- | --- | --- |
| 意図 | 人間 | レコードの intent |
| 設計 | reviewer | 設計節 / ADR |
| 実装 | reviewer | diff・テスト |
| 結果 | 人間 | デモ・指標・判断ログ |

- レビュー予算は既存のまま（reviewer は同時に1レーン、待ちはリードタイムの半分以下）。
- AI 一次レビューは、先に自チームのゴールデンセットで precision を測る。
- 月次15分で、先月の指摘3つを AGENTS.md / lint / test / eval / decisions に蒸留する。効果は再発数で見る。

却下: 単層レビューのまま（層が混ざる）、AI レビューだけに寄せる（precision が足りない）。

前提が変わる条件: 層を分けてもレビュー待ちが減らない、または蒸留が2カ月続かないとき。

## D070: 製品のループは外部に開き、hns は判断と記録だけを持つ

date: 2026-11-16 · by: user · issue: 0195

長期間のループ（意図→変更→証拠→成果→次の判断）は hns だけで閉じない。デプロイと障害はインフラ、利用と継続はプロダクト分析、声はサポート、収益は課金にある。hns が持つのは判断と記録で、観測値そのものではない。

- 接続は read-only の OutcomeSource。種類は deploy / infra / analytics / support / billing。
- 生データを複製しない。観測値・時刻・出所・信頼度だけを持つ。
- 取得できないときは unknown。成功に丸めない。
- 最初のコネクタはデプロイ / CI（0195 の J3）。

却下: hns にメトリクス基盤を持つ（BI の再実装になる）、外部 BI に判断も寄せる（判断の文脈が失われる）。

前提が変わる条件: 最初のコネクタでループが閉じない、または外部の認可・レート制限が現実的でないとき。

## D071: 仕事の記録を @hns/record に切る

date: 2026-11-16 · by: user · issue: 0196

D067 のレコードを、製品ドメイン（Project / Task）とは別のパッケージに置く。理由は3つ。記録は開発プロセスの語彙で、製品のモデルと寿命が違う。YAML と CLI を Node 側に閉じ込め、core と web を汚さない。製品統合（0197）で store / server / web が同じ schema を使える。

- パッケージは @hns/record。公開はモデル・schema・done level の導出・YAML 入出力・CLI。
- 依存する @hns は core だけ（時刻の codec）。yaml は exact pin、valibot は既存 workspace と同じ ^1.5.0。
- done level は導出のみ。レコードに level を書かない。
- 製品の WorkItem / Evidence への写像は 0197。record を製品の正本にしない。

却下: core に置く（YAML と CLI がコアに入る）、tools に置く（製品から使えない）、store に置く（D1 前提になり、CLI が使えない）。

前提が変わる条件: 製品が record を使わず CLI 専用になったとき（tools へ戻す）、または record が core の型に依存し始めたとき（境界を見直す）。

## D072: Worker の D1 binding と migration の版ファイル

date: 2026-11-16 · by: user · issue: 0189

Worker から D1 の store を開く経路を1回だけ作る。binding と migration の足し方を各面に任せると、同じ2ファイルを複数の issue が編集し、migration の順序と「いつ走るか」がばらける。

- `WorkerEnv.DB`（`@hns/store` の `D1Binding`）を1箇所で宣言し、face は `request.env.DB` で受け取る。face（0149 以降）は binding 不在・D1 障害・migration 失敗を 503 で fail closed にし、成功に見せない。
- `workerFor()` は `bindings.d1({ name: workerName })` を1件だけ宣言する。binding 名は `DB` で固定する。
- migration は1版1ファイル（`src/migrations/NNNN-name.ts`）とし、`index.ts` の配列に1行足す。`migrate()` は適用前に版が 1..n・昇順・重複なしを検証し、違反なら1文も実行しない。
- open は isolate の初回に1回で足りる（`openStore`）。`migrateStore` は deploy / 保守の入口として残す。
- migration は加算のみ（INV-12）。破壊的変更は expand → contract に分ける。

却下: 各面が自分の binding と配列の行を足す（衝突と順序のばらつき）、deploy 時の migration（前フックが未確認）、毎リクエスト open（cold start の利点が消える）。

前提が変わる条件: cf が binding 名で database を解決できない、または cold start の +1 read が計測で無視できなくなったとき。

## D073: GraphQL の schema は Query の factory から組む

date: 2026-11-16 · by: user · issue: 0176

0175 の `buildSchema(query: GraphQLObjectType)` では、server が model の型インスタンスを受け取れない。Query の field が `Project` を名指すには同じインスタンスが要るが、`buildSchema` は内部で作った型を返さないため、server が同じ名前の型を作ると GraphQLSchema が重複名で落ちる。

- `buildSchema(buildQuery)` に変える。factory は model の object 型の Map を受け取り、Query root を返す。
- core が型を作り、server はそのインスタンスで Query を組む。SDL（`buildSdl`）と実行時 schema は同じ型定義を共有する。
- Query の想定内の失敗は `QueryFailure` を含む union で返す（HTTP 200）。要求が成立しない場合（JSON でない・構文/検証で落ちる・上限超過・query 以外）は 400、想定外は 500。
- 読み先は resolver ごとに固定する。projects / tasks は D1、conversations は Session DO。resolver は他の resolver を呼ばない。

却下: server が `buildTypes()` を filter して `GraphQLSchema` を自前で組む（`buildSchema` と二重実装になる）、Query を手書き SDL にして `extendSchema` する（SDL を手で書かない決定に反する）、失敗を `errors` だけで返す（クライアントが分岐できない）。

前提が変わる条件: 0149 の索引が会話の読み先を D1 に変えたとき（resolver の読み先だけが変わる）、または subscriptions（0159）を同じ schema に載せるとき。

## D074: web は Relay 20.1.1 で読み、schema は server から生成する

date: 2026-11-17 · by: user · issue: 0178

D055 の「Relay を使う」を実装に落とす。react-relay / relay-runtime 20.1.1、relay-compiler 20.1.1、babel-plugin-relay 20.1.1、graphql 16.11.0 を exact pin する（PoC の実測と同じ組）。`@types/react-relay` / `@types/relay-runtime` は型だけ。

- `graphql` タグは babel-plugin-relay でコンパイルする。@vitejs/plugin-react 6 は babel オプションを持たないため、`packages/web/vite.relay.ts` の小さな plugin（@babel/core + babel-plugin-relay）を build と vitest の両方で使う。
- schema は `npm run codegen` が `@hns/server/graphql` の `buildSchemaSdl()` から `packages/web/schema.graphql` に書き、relay-compiler が `packages/web/src/__generated__/` に artifact を出す。**どちらも commit する**（0180 が drift をゲートで落とす）。
- 読みは 1 箇所の environment（network + store）に集め、fetch を注入できる。テストは実 fetch を出さない。
- TanStack Query は画面状態（ローディング・再取得の契機）に残す。読みの正本は Relay の store。

却下: schema を手で持つ（SDL が正本に反する）、graphql-codegen で web の型を作る（型は core のモデル）、vite-plugin-relay を足す（20 行の plugin で足り、依存を増やさない）、artifact を commit しない（ビルド時生成だけでは型検査が stale を見逃す）。

前提が変わる条件: Relay が babel を不要にしたとき、artifact の量がレビューを圧迫したとき、または subscriptions（0159）で同じ plugin が使えなくなったとき。




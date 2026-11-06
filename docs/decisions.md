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


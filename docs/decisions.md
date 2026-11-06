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

TypeScript strict / Node 24 / Fastify + zod / SQLite / React + Vite + CodeMirror 6 / Vitest + Playwright / **oxlint + oxfmt** + vendored anti-slop / **npm workspaces**（pi の packages 構成に倣う）。理由と棄却した選択肢は [engineering.md](../docs/engineering.md) §1。

## D027: 型が正本（type first）
date: 2026-11-07 · by: user · issue: 0031

`packages/core/src/types.ts` がモデルの正本。`validation.ts` の zod は `z.ZodType<T>` として型に適合させ、合わなければコンパイルで落とす。API 定義書は生成しない。
レスポンス検証は実サーバを起動して実 JSON を確認する（モックにしない）。UI は types.ts の型だけを使う。

## D028: AI slop はゲートで止める
date: 2026-11-07 · by: user · issue: 0031

レスポンス検証、noUncheckedIndexedAccess、vendored anti-slop（18 ルール。require-readable-spacing は oxfmt と衝突するため無効）、tsc --noEmit、oxfmt --check、knip、依存追加の ADR 必須、生成コードの明示、PR 1目的、TODO の issue 必須。エージェントの成果物も同じゲートを通す。詳細は [engineering.md](../docs/engineering.md) §4。
## D029: パッケージは 6 つで始める
date: 2026-11-07 · by: user · issue: 0032

core / workspace / agent / store / server / web。apps は作らず packages に置く（pi の coding-agent に倣う）。
providers は agent の中、identity は store の ./identity、Workflow と Automation は server の中。
状態の所有者と依存方向は [packages.md](../docs/packages.md)。育ったら orchestrator 等に切る。
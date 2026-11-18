# パッケージ構成

2026-11-07 決定（D029）。pi の packages を参考にした **8 パッケージ**（D047 で `machine`、D071 で `record` を足した）。
2026-11-10、D059 で `core` の意味を「系が合意する語彙（モデルと、その射影）」に確定した。

## 原則

- **状態の所有者は1つ**。境界は「変わりにくいところ」で切る。
- **依存は一方向**。`core` は誰にも依存しない。
- 機能名ではなく**状態と責務**で切る。
- 使う予定のない分割をしない。育ったら切る（今は切らない）。
- **宣言と実装は同じ変更に閉じる**。実装の無い面を先に宣言しない（D059）。

## 状態の所有者

| 状態                                                                  | 所有者                                   |
| --------------------------------------------------------------------- | ---------------------------------------- |
| 会話・実行・ツール呼び出し                                            | pi-durable（外部）。`agent` が組み立てる |
| ファイルの版・Journal・認可・イベント・exec 隔離                      | `workspace`                              |
| Project / Task / Conversation / Workflow / Automation / Usage / Event | `store`                                  |
| 利用者・セッション・秘密（passkey・token）                            | `server` の edge（`edge/session.ts` の cookie と codecs。0145）。`store` の `identity` subpath は無い |
| マシン側の実行（fs・署名の検証。exec は 0194）                        | `machine`                                |
| UI の一時状態                                                         | `web`                                    |

## パッケージ

| パッケージ       | 責任（公開するもの）                                                                              | 依存                                  |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `@hns/core`      | モデル（`types.ts`・`codecs.ts`）と、その射影。`./graphql` で SDL、`./capability` でツール呼び出しの契約、`./office` で Office の契約（0234） | —（id の検証に valibot、`./graphql` に graphql） |
| `@hns/record`    | 仕事の記録の schema・done level の導出・YAML・CLI                                          | core, valibot, yaml                   |
| `@hns/workspace` | 版付き読み書き・Journal・認可・イベント。`./sandbox` で exec 隔離                                 | core, pi-durable/env                  |
| `@hns/agent`     | Durable の組み立て、Tool（read/write/bash）、hooks（観測）、Model アダプタ（Ollama / OpenCode）。`./session` は Worker-safe な複数会話 runtime | core, workspace, pi-durable, pi-ai    |
| `@hns/store`     | D1、migration、リポジトリ、会話の索引（`./conversation-index`）。token・passkey・セッション・秘密は 0145 で移した先（今は `server/src/edge` の codecs） | D1                                    |
| `@hns/server`    | Worker（edge）・Durable Object（Session / Workspace）・GraphQL の resolver・認証・WS・Workflow / Automation の組み立て。`./graphql` は codegen 用の SDL | core, agent, store, workspace（0145 の edge は core を使わない） |
| `@hns/web`       | React UI（D043 で前倒し）。Relay で `/graphql` を読む（D055）                                      | core（モデル・SDL）                    |
| `@hns/machine`   | マシン側の常駐エージェント。署名検証、ROOT 封じ込め、上限。`ExecutionEnv` と sandbox は 0194 | core, workspace, valibot              |

## 依存グラフ

```text
web ───────────────► core
server ─┬─► agent ─┬─► workspace ─► core
        │          │            └─► pi-durable/env
        │          └─► core
        └─► store ─► core

machine ─┬─► workspace ─► core
         └─► core

record ──► core
```

- `agent` は pi-ai と pi-durable に依存する。`providers` は分けず、`agent/src/providers/` に置く。
- `workspace` と `store` は互いに独立。`machine` は `server` に依存しない（別に配布する）。
- `record` は core にだけ依存する（時刻の codec）。製品ドメイン（Project / Task）とは別の、仕事の記録の語彙を持つ。
- 逆向き（`store` → `server`、`core` → `workspace`）は禁止。`oxlint.config.ts` の `no-restricted-imports` がこの表と import を照合する（0042）。

## 境界の検査

`npm run check` の oxlint が、各パッケージの `@hns/*` import をこの表と照合し、違反で落とす。設定は `oxlint.config.ts` の `overrides` にあり、パッケージごとに許可する辺だけを残す。

未使用の export・依存・ファイルの検出は knip を使う（[0042](../work/issues/0042-boundaries-knip.md) で導入）。

パッケージを足すときは、この表と `oxlint.config.ts` の該当ブロックを同時に更新する。`machine` は 0147 で足した（`oxlint.config.ts`・`vitest.config.ts` も同じ変更）。`record` は 0196 で足した（D071）。

## 型の置き場所

**型は、その不変条件を持つパッケージに置く。** 全部を `core` に集めない。

| どこ             | 何を置くか                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- |
| `@hns/core`      | 永続するモデルと、2つ以上のパッケージが使う型（ID・日時・状態・Workflow / Automation） |
| `@hns/store`     | Row 型（DB の形）と、Row → 公開型の変換。JSON 列に入るモデル（graph / trigger / action）の検証 |
| `@hns/agent`     | 実行中の内部状態（Durable の検査結果など）                                              |
| `@hns/workspace` | ファイル操作の内部型（`FileRead` / `MutationResult` は core）                        |
| `@hns/record`    | 仕事の記録の型・schema・done level（製品の WorkItem とは別の語彙）                    |
| `@hns/server`    | 要求・応答の封筒、GraphQL の resolver が使う入力型、運用 view の型                      |

判断のしかた:

- **1パッケージしか使わない型は `core` に置かない。**
- **要求・応答の封筒は、その面を実装するパッケージが持つ。** 実装しない面の型を先に置かない。
- Row（`archived: 0 | 1`、DB の連番）と公開型（`archived: boolean`）を混ぜない。境界で変換する。
- Workflow / Automation を足すときは、公開 DTO と内部定義（グラフ・設定）を分ける。

いまの `types.ts` は「公開モデル」であり、製品の全モデルではない。育つと Row 型と内部型が各パッケージに増える。

GraphQL の SDL は `core` でモデルから起こす（D055）。型を先に書き、schema をそれに合わせる向きは変えない。
web は生成された SDL を build 時に読むだけで、schema を手で持たない。

## REST 面

REST は事前に宣言しない（D059）。GraphQL に載せない面（passkey・ファイルのバイト列・hooks・運用・machine）は、
それを実装する issue が schema・認証・handler を同じ変更で足す。

**今ある REST の面**（`edge/handler.ts` が正本。面ごとの契約は [contracts/](contracts/README.md)）:

| 面 | path | 実装した issue |
| --- | --- | --- |
| ファイルのバイト列 | `GET` / `POST /api/workspaces/:id/files` | 0157 |
| checkpoint | `/api/workspaces/:id/checkpoints/...` | 0245 |
| 会話と state | `GET` / `PATCH` / `DELETE /api/conversations/:id`（`/state`） | 0119 / 0271n |
| machine の鍵 | `GET /api/machines/keys` | 0148 |
| 運用 | `/api/events` / `/api/metrics` | 0162 |

- 一覧・検索・書き込みのアプリ契約は GraphQL（`/graphql`）。
- REST を足すときは、そのパッケージ内に schema と handler を置き、`core` に封筒を戻さない。

## exports の切り方

- `@hns/core`: `.`（モデルと検証）、`./graphql`（モデルから起こした SDL。web の bundle には入れない）、`./capability`（ツール呼び出しの契約。web は import しない。0220 で追加）、`./office`（Office の契約。型・schema・エラー・上限・machine の wire・cache のキー。0234 で追加。ルート entry には出さない）。
- `@hns/workspace`: `.`（Workspace）、`./sandbox`（ExecutionEnv デコレータ）、`./objects`（git object 互換の R2 ストア）、`./checkpoint`・`./pack`（0243 / 0247 の checkpoint と pack の読み取り）、`./mirror`・`./mirror-push`（0246 のミラー）、`./protocol`（machine への要求の封筒）。
- `@hns/store`: `.`（D1 のリポジトリ。Worker はこれをそのまま import する。`node:sqlite` を持たない）、
  `./conversation-index`（会話の索引。D078）。
- `@hns/agent`: `.`（Node の Agent）と `./session`（Worker-safe な複数会話 runtime。node: を import しない）。
- `@hns/machine`: `.`（常駐エージェント。署名検証・ROOT 封じ込め・上限）と `./cli`（`hns-machine enroll` / `run`。0270n）。
- `@hns/server`: `.`（Worker の default と Session / Workspace Durable Object）、`./graphql`（codegen 用の SDL。web は読まない）、`./edge`・`./checkpoint`・`./machines`（face の入口を test と deploy が直接使う）。


## 今は切らないもの

- `config`（環境変数）: `server` 内で起動時に1回パースする。
- Workflow / Automation の実行: `server/src/workflows` に置く。スケジューラと人間待ちが育ったら `@hns/orchestrator` に切る。
- `providers`: `agent` の中。`pi-ai` への依存をここに閉じ込める。
- `contract` / `api`: 作らない（D059）。wire は `core` の射影と、面を実装するパッケージに置く。

## 移行順

1. `workspace` ← `work/poc/workspace-core` + `sandbox.mjs`
2. `store` ← `work/poc/app/db.mjs` + `secrets.mjs` / `passkey.mjs` / `tailscale.mjs` / `recovery.mjs`
3. `agent` ← `work/poc/conversation` + ツール + hooks
4. `server` ← `work/poc/app/server.mjs`
5. `web` ← `work/poc/app/ui`（D043 で前倒し。画面単位）
6. `machine` ← `work/poc/cf-harness/agent`（0147）

各段で型検査を通す。
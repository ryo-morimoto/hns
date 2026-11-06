# パッケージ構成

2026-11-07 決定（D029）。pi の packages を参考にした **6 パッケージ**。

## 原則

- **状態の所有者は1つ**。境界は「変わりにくいところ」で切る。
- **依存は一方向**。`core` は誰にも依存しない。
- 機能名ではなく**状態と責務**で切る。
- 使う予定のない分割をしない。育ったら切る（今は切らない）。

## 状態の所有者

| 状態 | 所有者 |
| --- | --- |
| 会話・実行・ツール呼び出し | pi-durable（外部）。`agent` が組み立てる |
| ファイルの版・Journal・認可・イベント・exec 隔離 | `workspace` |
| Project / Task / Conversation / Workflow / Automation / Usage / Event | `store` |
| 利用者・セッション・秘密（passkey・token・tailnet） | `store/identity` |
| UI の一時状態 | `web` |

## パッケージ

| パッケージ | 責任（公開するもの） | 依存 |
| --- | --- | --- |
| `@hns/core` | モデル（types.ts） | — |
| `@hns/workspace` | 版付き読み書き・Journal・認可・イベント。`./sandbox` で exec 隔離 | pi-durable/env |
| `@hns/agent` | Durable の組み立て、Tool（read/write/bash）、hooks（観測）、Model アダプタ（Ollama / OpenCode） | core, workspace, pi-durable, pi-ai |
| `@hns/store` | SQLite、migration、リポジトリ。`./identity` で token・tailnet・passkey・セッション・秘密 | node:sqlite |
| `@hns/server` | HTTP / SSE / 認証の組み立て、Workflow・Automation、bin（`hns`） | 全部 |
| `@hns/web` | React UI（最後） | core（型のみ） |

## 依存グラフ

```text
web ───────────────► core
server ─┬─► agent ─┬─► workspace ─► pi-durable/env
        │          └─► core
        └─► store ─► core
```

- `agent` は pi-ai と pi-durable に依存する。`providers` は分けず、`agent/src/providers/` に置く。
- `workspace` と `store` は互いに独立。
- 逆向き（`store` → `server`、`core` → `workspace`）は禁止。境界検査は後で入れる。

## 型の置き場所

**型は、その不変条件を持つパッケージに置く。** 全部を `core` に集めない。

| どこ | 何を置くか |
| --- | --- |
| `@hns/core` | 2つ以上のパッケージが使い、ワイヤーで約束するもの（ID・日時・状態・公開 DTO） |
| `@hns/store` | Row 型（DB の形）と、Row → 公開型の変換 |
| `@hns/agent` | 実行中の内部状態（Durable の検査結果など） |
| `@hns/workspace` | ファイル操作の内部型（公開 DTO は core） |
| `@hns/server` | リクエスト/レスポンスの組み立て（型は core の公開 DTO を使う） |

判断のしかた:

- **1パッケージしか使わない型は `core` に置かない。**
- Row（`archived: 0 | 1`、DB の連番）と公開型（`archived: boolean`）を混ぜない。境界で変換する。
- Workflow / Automation を足すときは、公開 DTO と内部定義（グラフ・設定）を分ける。

いまの `types.ts` は「公開モデル」であり、製品の全モデルではない。育つと Row 型と内部型が各パッケージに増える。

## exports の切り方

- `@hns/core`: `.`（型・検証）。
- `@hns/workspace`: `.`（Workspace）、`./sandbox`（ExecutionEnv デコレータ）。
- `@hns/store`: `.`（リポジトリ）、`./identity`（認証・秘密）。exec を使わないアプリが
  bubblewrap に依存しないようにする。
- `@hns/agent`: `.`。
- `@hns/server`: `bin` のみ（`hns`）。ライブラリ利用はしない。

## 今は切らないもの

- `config`（環境変数）: `server` 内で起動時に1回パースする。
- Workflow / Automation の実行: `server/src/workflows` に置く。スケジューラと人間待ちが育ったら `@hns/orchestrator` に切る。
- `providers`: `agent` の中。`pi-ai` への依存をここに閉じ込める。

## 移行順

1. `workspace` ← `work/poc/workspace-core` + `sandbox.mjs`
2. `store` ← `work/poc/app/db.mjs` + `secrets.mjs` / `passkey.mjs` / `tailscale.mjs` / `recovery.mjs`
3. `agent` ← `work/poc/conversation` + ツール + hooks
4. `server` ← `work/poc/app/server.mjs`
5. `web` ← `work/poc/app/ui`（最後。D011）

各段で型検査を通す。
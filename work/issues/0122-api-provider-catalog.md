# 0122: Provider / model catalog と鍵の検証

status: open
priority: next
design: agreed
design-ref: D085
depends-on: 0034, 0145, 0146, 0151, 0198
touches: packages/core/src/graphql/, packages/core/test/graphql/, packages/agent/src/providers, packages/agent/test, packages/server/src, packages/server/test, tools/deploy/

## Goal

設定画面が、利用可能な provider / model と能力を一覧し、gateway の疎通を検証できるようにする。
鍵はアプリに保存せず、値もログも出さない。

## Acceptance criteria

- [ ] `Query.providers` が provider / models / capabilities（tools / vision / context / cost）を返す
- [ ] `Mutation.validateProvider(provider, model)` が gateway の chat route を 1 token ping して疎通を確認する
- [ ] 検証結果は ok / invalid_key / unreachable / unsupported / rate_limited。鍵の断片も返さない
- [ ] 鍵は gateway の deploy secret。アプリ / UI は保存しない（将来の UI 管理は未定）
- [ ] timeout（5 秒）と rate limit（provider ごと 30 秒 1 回）を設ける
- [ ] テスト: fake gateway で成功/失敗/タイムアウト、ログに鍵が出ない

## Notes

- agent の providers が能力の正本。server は集約するだけ
- model の能力差（tool 非対応など）を UI が先回りして仮定しない
- 0107 の Settings が使う

## 整理メモ（provider 鍵の置き場所、2026-11-17）

- 0122 の AC「鍵は 0069 の secret に保存し」は、0143 / docs/auth.md / 0151 の「provider 鍵は gateway の Worker secret だけに置く」と矛盾する。0151 は達成済みで、harness は鍵を持たない。
- 選択肢: (a) gateway の deploy secret（現行）。0122 はカタログと検証（gateway 経由）だけを持ち、UI に鍵入力は無い。(b) UI 管理の service secret（0069）に置き、gateway が読む（0143 の改訂、呼び出しごとの D1 read、鍵が Worker secret でなくなる）。(c) 併用。
- **推奨は (a)**。0107 の「保存済み / 未設定」も gateway の設定状態に読み替える。
- 検証の呼び先: gateway の chat route を 1 回叩くか、`/v1/<provider>/models` を gateway に足すか。後者は 0151 の面を広げるので、0152 と一緒に決める。
- 0122 の depends に 0151 / 0198 を足すかは、面の設計で決める（validation は Mutation）。
## Design（D085 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D085）。

### 前提

- provider 鍵は **gateway の Worker secret だけ**（0143 / docs/auth.md / 0151）。harness は鍵を持たず、`@hns/store/identity` の service secret とは別物。AC の「0069 に保存」は PoC の記述で stale。
- 0151 の gateway は `POST /v1/<provider>/chat/completions` の固定ルートを持ち、鍵は deploy secret、予算は D1。
- agent の providers は provider ごとに1モデルを定義している（ollama-cloud / opencode-go）。能力（tools / vision / context / cost）はここが正本。
- 0152 が harness を gateway 経由に差し替える。0122 の検証はそれと独立に、gateway の chat route を直接叩ける。

### 決定 1: 鍵は gateway のまま。0122 はカタログと検証に絞る

- アプリは provider 鍵を保存しない。UI に鍵入力を作らない。0069 の service secret は provider 以外（webhook 等）に使う。
- 0107 の「保存済み / 未設定」は **gateway の設定状態**（検証結果）に読み替える。
- 0122 の AC から「鍵は 0069 の secret に保存」を外す（D0NN で記録）。

### 決定 2: カタログは `@hns/agent` の静的表

- `providers/catalog.ts` に `PROVIDER_CATALOG` を置く: provider（id / label）、models（id / name / tools / vision / contextWindow / maxTokens / cost / default）。
- アダプタはこの表からモデル定義を作り、二重管理しない。cost は推定値（0152 / 0163 の実測で更新）。
- `Query.providers` はこの表を返す。provider の `/models` を動的に引かない（能力を返さない API があるため）。

### 決定 3: 検証は gateway の chat route を 1 回叩く

- `Mutation.validateProvider(provider, model)` → `ok` / `invalid_key` / `unreachable` / `rate_limited` / `unsupported`。
- 呼び先は gateway の `/v1/<provider>/chat/completions`（`max_tokens: 1` の ping）。鍵は gateway が持つので、アプリから鍵を送らない。
- 応答の写像: 401/403 → `invalid_key`、404 / 未知 model → `unsupported`、429 → `rate_limited`、5xx / network / timeout（5 秒） → `unreachable`。
- 主 Worker に GATEWAY の service binding を足す（tools/deploy の設定）。dev / test は fake gateway。
- 予算を消費する。検証は provider ごとに 30 秒 1 回に制限し、UI に「検証は 1 回のモデル呼び出し」と出す。
- 鍵の断片・本文を応答 / ログに出さない。

### 決定 4: 面と依存

- GraphQL: `Query.providers` と `Mutation.validateProvider`（0198）。
- `depends-on` に **0151**（gateway）と **0198**（Mutation）を足す。0152 は依存にしない（検証は gateway を直接叩ける。実モデルの配線は 0152）。
- touches に `server/src/graphql/`、`agent/src/providers/`、`tools/deploy/`（GATEWAY binding）を足す。

### 決定（D085）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 鍵の置き場所 | **決定（user）**: gateway の deploy secret のまま。UI 入力なし（将来 UI 管理の可能性は残す） | 0143 / 0151 / 0107 | 2026-11-17 |
| U-02 | 検証の呼び先 | **決定（user）**: gateway の chat route（ping 1 token）。health route は作らない | 0151 / 0152 | 2026-11-17 |
| U-03 | カタログの正本 | **決定（user）**: `@hns/agent` の静的表。アダプタが使う | 0034 / 0152 | 2026-11-17 |
| U-04 | 検証の面 | **決定（user）**: Mutation（0198）。Query にしない | 0198 | 2026-11-17 |
| U-05 | 0107 の鍵入力 | **決定（user）**: 削除し、検証結果だけ出す | 0107 | 2026-11-17 |
| U-06 | 将来の UI からの鍵設定 | 未定。要求が出たら 0143 を改訂し、保存先と読み出しを決める | 0143 / 0151 | 要求時 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | Query.providers → カタログが provider / model / 能力つきで返る（決定性） | 高 | 受入1 |
| C2 | fake gateway 200 → ok。応答に鍵の断片が無い | 高 | 受入2・3 |
| C3 | 401/403 → invalid_key、404 → unsupported、429 → rate_limited、5xx / timeout → unreachable | 高 | 受入3 |
| C4 | 30 秒以内の再検証 → 制限（rate_limited / 単一飛行） | 中 | 受入5 |
| C5 | ログ / 例外メッセージに鍵・本文が出ない | 高 | 受入3 |
| C6 | 0107 の Settings → 「設定済み / 未設定」を検証結果から出す（鍵入力なし） | 中 | 0107 |
| C7 | `npm run check` | 高 | — |

層は unit（catalog / 写像）、GraphQL の契約テスト、gateway の fake で C2–C4。実 provider は 0152 の smoke。

## Log

- 2026-11-17: D085 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

## やらないこと

- OAuth（0128）
- モデルの自動ダウンロード

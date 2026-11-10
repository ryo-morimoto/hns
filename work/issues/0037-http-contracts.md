# 0037: HTTP 契約と型付きクライアント

後継: D055（GraphQL をアプリ契約にする）と 0188（REST 契約の撤去）。REST 面は面ごとの issue が持つ。

status: superseded
priority: now
depends-on: 0031
touches: packages/core, packages/web

## Goal

全 API の入出力を valibot schema にし、server と web が同じ型を使う。

## Acceptance criteria

- [x] 全エンドポイントの request / response schema（`GenericSchema<unknown, T>`）
- [x] SSE イベントも型にする
- [ ] server は入口で必ず parse する（0035 で）
- [ ] web はレスポンス型を手書きしない（0036 で）

## Result

- `packages/core/src/http.ts`: ワイヤ専用の型（Workflow / Automation / Secret / Passkey / SSE など）。
  ドメインの型は `types.ts`、ブランドの schema は `schemas.ts`。
- `packages/core/src/http-schemas.ts`: 49 ルートの request / response schema と `ROUTES` 表。
  パスは `:id` 形式で、キーは `METHOD /path`。応答の失敗は `ErrorResponseSchema`。
- `packages/core/test/http.test.ts`: 26 ケース（受理・拒否・ルート表の整合）。
- `packages/core/src/contract.ts` / `result.ts`: 境界 parse を `Result<RouteRequest<K>, ContractError>` で返す
  （Effect / Payload の「境界で parse・失敗は値」）。`test/contract.test.ts` 7 ケース。core は 41/41。
- 契約を書いて見つかったモデルのずれを直した:
  - `EVENT_NAMES` に `chat.rate_limited` / `chat.budget_exceeded` を追加（PoC が発行していた）
  - `SandboxStatus` を 0006 の検出結果（exec / backend / userNamespaces / code / reason）に更新
  - `TaskState` / `Scheduling` / `AuthMode` を const array 由来の union に（schema と型を一致させるため）
- Passkey の WebAuthn ペイロードは `@simplewebauthn` の所有なので `JsonValue` のまま。周辺の項目だけ型にする。
- 2026-11-10: D055 により、web のアプリ契約は GraphQL になった。ROUTES は passkey / hooks / 運用 / マシンの面と、
  SDL の出所になるモデル型の検証に残る（49 ルートのうち 22 がこちら側）。

## Log

- 2026-11-07: 作成。core 側の契約と表を実装。server / web の適用は 0035 / 0036。
- 2026-11-07: golden example（Payload / Effect）に合わせ、境界 parse の helper と Result を追加。
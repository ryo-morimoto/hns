# テスト

2026-11-07 / D038。`npm run check` の一部。ランナー・層・禁じ手を1箇所に固定する。

## ランナー

- **Vitest 5.1.0**（exact pin）。`vitest.config.ts` の `projects` でパッケージを分ける。
- `npm test` = `vitest run`（全部）。`npm test -w @hns/store` = そのパッケージだけ。
- watch は `npx vitest`。coverage はゲートに入れない（必要になってから閾値ごと決める）。
- アサーションは **`node:assert/strict` に統一**。`expect` は使わない（書き方を1つにする）。
- テストも `tsc --noEmit` の対象。`any`・`@ts-ignore`・根拠のない `as` は禁止。
- `retries: 0`。flaky をリトライで隠さない。

## 層

| 層 | 対象 | 置き場所 | 制約 |
| --- | --- | --- | --- |
| unit | 型・schema・遷移 | `packages/core/test` | I/O なし |
| contract | valibot と wire の往復 | `packages/core/test` | route と schema を照合 |
| repository | migration・Row・parse | `packages/store/test` | **実 SQLite**。モック禁止 |
| integration | 実 FS・実プロセス・sandbox | `packages/workspace/test`, `packages/agent/test` | temp dir。bwrap 無しは `t.skip` |
| API | Fastify inject・SSE | `packages/server/test` | 実 port を開けない。実 store/workspace |
| E2E | browser | `packages/web/test/e2e`（0043） | ツールは 0043 で決める。Chromium 無しは skip |

- Vitest のファイルは `packages/<pkg>/test/*.test.ts`。E2E は別ディレクトリに置く（ツールは 0043 で決める）。
- E2E は `npm run check` に入れない。別コマンドと CI ジョブにする（0043）。
- fixture はパッケージ内の `test/support.ts`。共有 fixture パッケージは作らない。
- DB は `:memory:` か temp file。テストごとに開いて閉じる。スキーマは本物を通す。

## 書き方

1. **失敗を先に書く。** 非自明なテストには `// Catches: <1行>`。言えないテストは消す。
2. **1テスト1振る舞い。** 名前は「何が壊れたら落ちるか」。
3. **失敗経路を必ず。** 不正入力、違法遷移、conflict、未知 enum、拒否パス。
4. **永続化はモックしない。** 壊れた Row は `ValiError` で落ちることも見る。
5. **外部は境界で fake。** モデルは faux、時計・ID は注入。ネットワークに出ない。
6. **待つときは期限付き。** `sleep` で同期しない。SSE は終端イベントまで読む。
7. **並列が既定。** テストごとに temp dir / DB。共有状態なし。port は inject。
8. **環境要因だけ skip。** bwrap / Chromium / watch 不可。`t.skip("理由")`。

## ゲート

- `npm run check` = oxlint → oxfmt → tsc → `vitest run` → build。
- CI も同じコマンド。テストのためだけの別ランナー・別設定を作らない。
- テストを足さない変更は「何を証明したか」を説明する。

## 参考（golden examples）

| リポジトリ | 取ったもの | 出所 |
| --- | --- | --- |
| Trigger.dev | 失敗前提、実 DB（testcontainers）、長いテストの分割 | [AGENTS.md](https://github.com/triggerdotdev/trigger.dev/blob/main/internal-packages/run-engine/AGENTS.md), [vitest.config.ts](https://github.com/triggerdotdev/trigger.dev/blob/main/apps/webapp/vitest.config.ts) |
| Medusa | module integration runner、worker ごとの実 DB | [package.json](https://github.com/medusajs/medusa/blob/develop/packages/modules/order/package.json), [setup-env.js](https://github.com/medusajs/medusa/blob/develop/integration-tests/setup-env.js) |
| Twenty | 層ごとの config、integration は `maxWorkers: 1` | [CLAUDE.md](https://github.com/twentyhq/twenty/blob/main/CLAUDE.md), [jest-integration.config.ts](https://github.com/twentyhq/twenty/blob/main/packages/twenty-server/jest-integration.config.ts) |
| Payload | feature ごとの `config.ts` / `int.spec.ts` / `e2e.spec.ts`、Vitest projects | [package.json](https://github.com/payloadcms/payload/blob/main/package.json), [int/vitest.ts](https://github.com/payloadcms/payload/blob/main/test/__helpers/int/vitest.ts) |
| Effect | `it.effect`、TestClock、integration を env で gate | [vitest.config.ts](https://github.com/Effect-TS/effect/blob/main/vitest.config.ts), [Effect.test.ts](https://github.com/Effect-TS/effect/blob/main/packages/effect/test/Effect.test.ts) |

外部の真似ではなく、hns では「実 SQLite」「fastify.inject」「skip は環境要因だけ」に絞る。

# 0189: Worker から D1 の store を開通させる

status: in-progress
priority: now
depends-on: 0145, 0150
touches: packages/store/src/migrate.ts, packages/store/src/migrations/, packages/store/test/, packages/store/README.md, packages/server/src/edge/env.ts, packages/server/src/edge/handler.test.ts, packages/server/test/support/edge.ts, packages/server/package.json, packages/server/README.md, package-lock.json, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts, ARCH.md, docs/decisions.md

## Summary

Worker から D1 の store を開く経路を1回だけ作る。D1 の binding を `WorkerEnv` に足し、migration を版ごとのファイルに割る。
0148 / 0149 / 0151 は表を足し、0158 / 0176 は D1 を読む。どれもこの2点を自分の変更で触らずに済む。
migration は isolate の初回 open で1回だけ走らせ、それ以外の契機は採らない。
理由は、`openStore` が既に migrate し、D1 の読み取り回数をリクエスト単位で増やさないため。

## Goal

- D1 の binding を1箇所で宣言し、以後の面が同じ設定を編集しない。
- migration の追加を「新しいファイル1つ + 配列への1行」にし、以後の面が同じ配列を奪い合わない。
- どちらも、既存の `migrate()` の保証（原子性・単調性・新しすぎる DB の拒否）を変えない。

## Acceptance criteria

- [ ] `WorkerEnv` に `readonly DB?: D1Binding | undefined` を `@hns/store` の型で足す。binding 未設定でも起動時に throw しない
- [ ] `workerFor()` が `DB` を `bindings.d1({ name: deployment.workerName })` で1件だけ宣言する。`config.test.ts` で `type: "d1"` と名前を固定する
- [ ] edge の face が `request.env.DB` で binding を受け取れることを `handler.test.ts` の1ケースで固定する
- [ ] `packages/store/src/migrations/0001-initial.ts` と `index.ts` に分割し、`migrate.ts` は `MIGRATIONS` を import する
- [ ] `migrate(sql, migrations = MIGRATIONS)` が最初の SQL より前に配列を検証し、版が 1 から昇順・重複なしでなければ適用せず `Error` を投げる（第2引数はテストのためだけに開ける）
- [ ] 版の追加が「新しいファイル1つ + index への1行」で済むことを、fixture の v2 を配列に足すテストで示す
- [ ] v1 の DB に v2 を適用すると `schema_migrations` が 2 になり、既存の行は残る
- [ ] ビルドより新しい DB の拒否と、再 open の no-op が既存どおり（既存テストが通る）
- [ ] `openStore` を2回呼んでも安全（冪等）であることを既存の open テストで示す（新規に作らない）
- [ ] `ARCH.md` に INV-12（migration は新規テーブルと nullable/既定値付きの新列のみ・古い build は新しい DB を開かない）を足す
- [ ] `packages/store/README.md` と `packages/server/README.md` に、migration の置き場所と `DB` binding を1行ずつ反映する
- [ ] `npm run check` が通り、独立レビューが PASS する（Result に記録）

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | binding 未設定の env → 既存の handler suite → 通る（`DB` は optional なので起動時に throw しない。新規に作らない） | 高 | 受入1 |
| C2 | `workerFor()` → binding を見る → `DB` が `type: "d1"` で、名前が workerName と一致する | 高 | 受入2 |
| C3 | DB を渡した env → edge の face を呼ぶ → face が同じ binding を受け取る | 高 | 受入3 |
| C4 | v1 の DB → fixture の v2 を第2引数で渡して migrate → `schema_migrations` が 2、既存行が残る | 高 | 受入6・7 |
| C5 | 版が昇順でない / 重複 / 1 から始まらない配列 → `migrate()` に渡す → 最初の SQL より前に throw し、`schema_migrations` も作られない | 高 | 受入5 |
| C6 | 版2の DB → 版1だけのビルドで開く → 拒否（既存の `store.test.ts` が固定。新規に作らない） | 中 | 受入8 |
| C7 | 同じ DB に2回 open → 2回目も成功し、既定プロジェクトが重複しない（既存の `store.test.ts` が固定） | 中 | 受入9 |
| C8 | 全変更 → `npm run check` → 通る | 高 | 受入12 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 既存の回帰 | unit | 既存の `packages/server/src/edge/handler.test.ts`（新規に作らない） |
| T2 | C2 | 設定の固定 | unit | `tools/deploy/config.test.ts` |
| T3 | C3 | 通過の固定 | unit | `packages/server/src/edge/handler.test.ts`（fake の binding を env に渡し、face が受け取る） |
| T4 | C4–C5 | 同値分割 + 境界 | integration | `packages/store/test/integration/store/migrate.test.ts`（新規。miniflare の D1） |
| T5 | C6–C7 | 既存の回帰 | integration | `packages/store/test/integration/store/store.test.ts`（既存。新規に作らない） |
| T6 | C8 | ゲート | static / build / integration | `nix develop --command npm run check` |

## Problem / context

- store は D1 専用（D064）だが、`WorkerEnv` は `ASSETS` / `SESSION` / `HNS_SESSION_SECRET` だけを持つ。Worker から D1 を開く binding が無い。
- `workerFor()` も `d1_databases` を宣言していない。あるのは `Session` の export、secret、`HNS_ENV` / `HNS_AGENT_URL` / `HNS_MODEL` の text だけ。
- migration は `packages/store/src/migrate.ts` の1配列 `MIGRATIONS = [{ version: 1, sql: SCHEMA_V1 }]`。表を足す issue が全部同じ配列を編集する。
- 0148（Machine）・0149（索引）・0151（予算）は D1 の表を足す。0158（認証）と 0176（resolver）も D1 を読む。表を足す issue が増えるたびに同じ2ファイルで衝突する。
- `openStore` は既に migrate し、「isolate ごとに1回で足りる」と TSDoc に書いてある。呼び出し側の形はまだ無い。

## Users and use cases

- **0149 / 0176 を書く開発者**: 会話と run の索引を書き、resolver から読む。binding の名前・migration の足し方・open の回数を自分で決めたくない。
- **0151 を書く開発者**: 予算のカウンタを1文の `UPDATE` で持つ。0151 の予算表を足すときに `migrate.ts` を触りたくない。
- **運用者**: schema は前進のみ。migration を伴う deploy では、旧 Worker が新しい DB を開こうとすると 503 になる（INV-12 と Invariants の「旧 Worker + 新 schema」）。戻すときは Worker と D1 をセットで戻す。

## Non-goals

- 各面の handler（0148 / 0149 / 0151 / 0158 / 0176）。
- 表の追加（machine・予算・索引）。
- store の読み取りキャッシュ・クエリビルダの一般化。
- 疎通確認用の face（`/health` など）。
- deploy 時の migration 実行（Option C。U-04）。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A | 何もしない。各面が自分の binding と配列の行を足す | 変更が無い | 同じ2ファイルを複数の面が編集する。migration の順序と「いつ走るか」がばらける | 高 | 低 |
| B | binding + 版ファイル + isolate 初回 open + store の型（**推奨**） | 衝突点が1つに閉じる。型の出所が1つ。順序と契機が1箇所で決まる | `@hns/store` への依存が1つ増える | 中 | 中 |
| C | binding + 版ファイル + deploy 時の `migrateStore` | 実行時に migration のコストが無い。失敗が deploy で止まる | deploy 前フックがあるか未確認（U-04）。deploy 手順が増える | 中 | 中 |
| D | binding + 版ファイル + 毎リクエスト open | 状態を持たない | D1 の read をリクエストごとに1回払う。cold start の利点が消える | 中 | 低 |
| E | B の型だけ stand-in にする（依存を足さない） | lock を触らない | 最初の利用者で本物の型に置き換える。stand-in と `@hns/store` の drift | 中 | 低 |

A は「衝突しない」が、0149 と 0151 が同じ表を別々の順序で足したときに検出できない。
C は deploy 前フックが未確認（U-04）。D は読み取り回数が増える。E は依存を1つ増やさないが、0149 で必ず置き換える。
B だけが goals と「以後の面が触らない」を同時に満たす。

## Recommendation

B を採る。

前提:

- isolate の寿命で open は1回で足りる（`openStore` の TSDoc と同じ）。
- cf は `bindings.d1({ name })` の名前で database を解決する（id は optional）。
- `package-lock.json` は空いている（0146 は 024bb03 で統合済み）。
- migration は加算のみを守る（INV-12 は AC10 で ARCH に足す）。

前提が崩れたとき:

- cf が名前で解決できない → U-01。binding に id を環境変数から渡す。
- 別のレーンが lock を取った → 版ファイルの分割（store だけ）を先に統合し、binding の commit を待たせる。E は採らない。
- isolate の寿命で足りない → 0149 の provider で形を決め直す（C / D を再検討）。

## Design: guide-level

**migration を足すとき**

1. `packages/store/src/migrations/0002-add-machine.ts` を作り、`{ version: 2, sql: "..." }` を export する。
2. `packages/store/src/migrations/index.ts` の配列に1行足す。
3. v1 の DB に v2 を適用する integration テストを足す（0189 は fixture の v2 を渡す。実ファイルを足すのは表を足す issue）。

SQL は `migrate.ts` が `;` で分割する。TRIGGER や `;` を含む literal は書かない（必要になったら分割器を別 issue で変える）。

before: `migrate.ts` の `SCHEMA_V1` を直接編集し、全 issue と同じ行で衝突していた。
after: 新しいファイルを1つ足すだけで、他の issue と衝突しない。

**面が DB を使うとき**

```ts
const db = request.env.DB;
if (db === undefined) {
  return problem("unavailable", "The database binding is not configured.", path);
}
```

0149 はここから `openStore` を isolate の初回だけ呼ぶ provider を足す（この issue では作らない）。0149 の AC と `touches` への反映は 0193 が行う。

**失敗したときの見え方**

binding が無い / D1 が落ちている / migration が失敗する のいずれも、face は 503 `unavailable` を返す。成功に見せない。

## Design: reference-level

**ファイル構成**

```
packages/store/src/migrations/
  migration.ts      # Migration（version / sql）
  0001-initial.ts   # 既存の SCHEMA_V1 を移す
  index.ts          # import して MIGRATIONS を export
packages/store/src/migrate.ts  # MIGRATIONS を import。適用ループは変えない（引数と適用前検証だけ足す）
```

**MIGRATIONS の不変条件**

- 1 から始まり、昇順で重複なし。
- `migrate(sql, migrations = MIGRATIONS)` は最初の SQL（`schema_migrations` の作成）より前に検証し、違えば1文も実行せず `Error` を投げる。既存の版スキップ（3 → 2 を黙って飛ばす）を作らない。
- 第2引数は `MIGRATIONS` が既定で、テストが不正な配列と fixture の v2 を渡すためだけに開ける。public な export は増やさない。
- テストは `packages/store/test/integration/store/migrate.test.ts` から `../../../src/migrate.ts` と `../../../src/sql.ts` を相対 import する。`src/index.ts` の public export（`migrateStore`）は増やさない。

**binding**

- `WorkerEnv` に `readonly DB?: D1Binding | undefined`（`@hns/store` の `D1Binding` を `import type`）。
- `EdgeRequest.env` は既に全 face に渡っているので、`HandlerDependencies` は変えない。seam は `env` の1フィールドで足りる。
- `workerFor()`: `DB: bindings.d1({ name: deployment.workerName })`。binding 名は `DB` で固定する。
- 型の出所は `@hns/store`。server に `"@hns/store": "0.1.0"` を足す（type-only import なので bundle には入らない）。

**open の契機**

- runtime は `openStore` だけ。isolate の初回に1回。0149 が provider として実装し、呼び出し回数をテストで固定する。
- `migrateStore` は deploy / 保守の入口として残す（この issue では呼ばない）。

## Invariants and failure modes

| 不変条件 / 失敗 | 何が起きるか | 扱い |
| --- | --- | --- |
| MIGRATIONS は 1 から昇順・重複なし | 違反すると版が黙って飛ぶ | 最初の SQL より前に検証して throw |
| migration は1版 = 1 batch + 版行 | 途中で失敗すると版が進まない | D1 の batch 原子性に任せる |
| 版は単調 | 古いビルドが新しい DB を開く | 拒否（既存挙動、503） |
| migration は加算のみ | 既定値の無い NOT NULL 列や、既存列の型・制約・索引の変更は、前に書かれた行と新しい build を食い違わせる | 新規テーブルと nullable / 既定値付きの新列に限る。破壊的変更は expand → contract |
| 2 isolate が同時に適用 | 片方が負ける | 版を読み直し、進んでいれば成功として扱う（既存） |
| binding 不在 | 起動時に落ちる | 落とさない。face が 503 |
| D1 障害 | 読み書きが失敗 | 503。成功に見せない |
| seed の失敗 | open が途中で失敗 | adapter を閉じて throw（既存） |
| 旧 Worker + 新 schema | 起動時に `current > latest` で throw する | 開かせない（503） |

## Cross-cutting concerns

- **Security**: binding は Worker の中だけ。migration の SQL に秘密を入れない。D1 を公開しない。
- **Observability**: migration の失敗は open を呼ぶ face が `requestId` 付きで記録する（0145 の相関 ID。実装は 0149 の provider）。成功時は記録しない。
- **Operability**: schema は前進のみ。旧 Worker が新しい DB を開くと 503 になるので、migration を伴う deploy は D1 の復元点を確認してから行う（0164）。
- **Cost / performance**: cold start の migration 分は 1 batch（no-op の `CREATE TABLE IF NOT EXISTS schema_migrations`）+ 1 read。`openStore` はさらに `ensureDefault` で 1 read（初回は insert + 再 read）。リクエストごとには払わない。
- **Accessibility / i18n**: 対象外（UI を持たない）。

## Compatibility, migration, rollback

- binding は加算。削除すると面は 503 になるが、既存の face の振る舞いは変わらない。
- migration は append-only。適用済みの版を書き換えない。
- **rollback は Worker と D1 をセットで戻す**。旧 build は新しい DB を `current > latest` で拒否する（fail closed、503）。復元点（Time Travel）の確認手順は 0164。
- 旧 build が新しい schema で動く保証はしない。互換は「新しい DB を古い build が開かない」で守る。
- 破壊的変更（列の削除・改名・型・制約・索引）は expand → migrate → contract の3段に分ける。0189 では行わない。

## Test plan

| 条件 | 層 | ファイル |
| --- | --- | --- |
| binding 無しの env が既存どおり通る（C1） | unit | 既存の `packages/server/src/edge/handler.test.ts`（新規に作らない） |
| `workerFor()` の `DB` と Session export（C2） | unit | `tools/deploy/config.test.ts` |
| binding が face に届く（C3） | unit | `packages/server/src/edge/handler.test.ts` |
| v1→v2 / 不正な配列（C4–C5） | integration | `packages/store/test/integration/store/migrate.test.ts`（新規） |
| 新しすぎる DB の拒否 / 2回 open（C6–C7） | integration | 既存の `packages/store/test/integration/store/store.test.ts`（新規に作らない） |
| ゲート（C8） | static / build | `nix develop --command npm run check` |

成功の指標: 版の追加がファイル1つ + 1行。`MIGRATIONS` の検証テストが落ちる変更を入れられないこと。

## Rollout and graduation

- 0189 の binding は 0149 まで dormant。面はまだ読まないので、利用者には見えない。
- 0149 が provider と once-per-isolate の memo を足し、呼び出し回数をテストで固定する。ここで graduation。
- 0149 の AC と `touches` に provider seam を足す。backlog への反映は 0193 が行う。
- abort 条件: migration の失敗が1回でも起きたら deploy を止め、Worker と D1 を戻す（0164 の手順）。cold start の p95 が計測前より 50ms 以上悪化したら D1 の契機を見直す。

## Notes

- 現行の `openStore` は migrate と既定プロジェクトの seed を行う。順序は変えない。
- cf の config API は `bindings.d1({ id?, name?, dev? })` を持つ（`@cloudflare/config` の型で確認済み）。
- `tools/deploy` は workspace ではないので、D1 の binding 名は config の1箇所だけで決まる。
- 0146 は main に統合済み（024bb03）で、`package-lock.json` は空いている。dep を足す commit を待たせない。
- 0148 / 0151 の `touches` が指す `store/src/migrations/d1/` は、0193 が flat な `migrations/` に直す。
- 決定は実装開始時に `docs/decisions.md` へ D067 として追記する（最新は D066。D066 は並列の単位をファイルにした決定）。
- owner / reviewer は [LANES](../LANES.md) の E9 を正とする。

## 未確定

- U-01: cf が `bindings.d1({ name })` の名前で database を解決できるか。`cf d1 create` が要るか、local dev で name だけで動くかを含む / 仮説: 名前で解決し、dev は自動作成 / 影響: deploy と開発の手順 / 責任者: user / トリガー: 0151 の deploy 実機確認。
- U-02: 0149 の provider の形（`() => Promise<Store>` を deps に置くか、face が自分で open するか） / 仮説: deps に置く / 影響: 0149 の変更範囲 / 責任者: user / トリガー: 0149 着手時。
- U-03: cold start の +1 read の実測 / 仮説: 無視できる / 影響: D1 の契機の再検討 / 責任者: user / トリガー: 0151 の計測。
- U-04: deploy 前フック（migration を deploy 時に実行する手段）があるか / 仮説: 無いので runtime の open で走らせる / 影響: Option C の採否 / 責任者: user / トリガー: 0164 か deploy 手順を書くとき。
- U-05: migration を伴う deploy の rollback 手順（D1 の復元点の取り方）/ 仮説: deploy 直前に復元点を確認する / 影響: 0164 の runbook / 責任者: user / トリガー: 0164 着手時。

## やらないこと

- 各面の handler（0148 / 0149 / 0151 / 0158 / 0176）。
- 表の追加。
- 疎通確認用の face。
- deploy 時の migration 実行（Option C。U-04 の結果次第で別 issue）。
- store の読み取りキャッシュ・クエリビルダ。

## Log

- 2026-11-11: 作成（0141 / 0146 と並行する3本目。0148 / 0149 / 0151 / 0158 の共通前提）。
- 2026-11-11: RFC / design doc の形に再構成（rfc-design-docs）。D1（isolate 初回 open）/ D2（版ファイル）/ D3（store の型）/ D4（binding と env の seam）/ D5（INV-12）/ D6（migrateStore は保守用）を決めた。
- 2026-11-11: seam は `HandlerDependencies` ではなく `EdgeRequest.env` にした（env は既に全 face に渡っており、依存の口を増やさないため）。
- 2026-11-16: 実装。`WorkerEnv.DB`（@hns/store の `D1Binding`）、`workerFor()` の `bindings.d1({ name })`、migration の版ファイル分割（`src/migrations/`）、適用前の 1..n 検証、integration テスト（v1→v2・不正な配列）、`ARCH.md` の INV-12、D072。`npm run typecheck`（store / server / deploy）と unit + store integration が通過。
- 2026-11-16: 独立レビュー（review-0189 / FAIL）を受けて修正。rollback は Worker と D1 をセットにし、旧 build は新しい DB を開かない（fail closed、503）と明記した。テストの重複を既存テスト参照に、lock の前提を 0146 統合済みに更新した。

## Result

- design review: review-0189 / FAIL（blocking 1）→ 修正 → **PASS**（blocking 0、comment 2 / nit 6）→ nit 3 を反映（2026-11-16）。HEAD 4655088（review 時）+ 作業ツリー
- 実装レビュー: 未実施（実装後に記入）

# 0043 製品 E2E の設計資料（cf / Playwright / テスト管理 / 性能）

2026-11-17 / 調査担当: e2e-research / 対象: 0043（製品の E2E テスト）の U-01・U-02・U-05・U-06・U-07
方針: コードは変更しない。事実は「確認済（一次資料・実測）」「推測」「未確認」を明記する。

## 0. 結論（先に読む）

- **実行環境は `cf dev --mode development` + Vite のまま**（D065 と整合）。実測で `cf dev` の cold start は 2.0〜2.2 秒、Vite 8.3.6 の dev ready は 200〜250 ms。起動は性能上のボトルネックではない。ボトルネックは **seed と待ち合わせ、trace/video、サーバ再起動の回数**。
- **E2E 用の cf プロジェクトに Vite を同居させない**。`cf dev` は Vite を検出すると `npx vite` へ委譲し、`--mode` 以外の引数（`--port` を含む）を**拒否**する（実測で再現、§2.5）。UI の Vite は別プロセスとして起動する。
- **state 分離は「プロジェクトディレクトリ」単位**。wrangler の local state は `<project>/.wrangler/state/v3` に置かれ、`XDG_CONFIG_HOME` はログ・registry にしか効かない（実測）。したがって「XDG を分けるだけ」では D1/DO は分離されない。**1 サーバ + テストごとに一意な id** を基本にし、完全分離が要るテストだけ一時プロジェクト + 別ポートで `cf dev` を立てる。
- **`--persist-to` は `cf dev` では明示エラー**（`--persist-to is not supported by cf dev.`）。`--local` も dev では非対応。D1 の直接 seed に使う `cf d1 raw --local` は**dev サーバのデータを見ない**（公式ドキュメントが明記）。seed は HTTP（テスト専用 Worker の route）か DO RPC で行う。
- **trace は `on-first-retry` 固定、video は off**。trace のスナップショット有効化は action の多いテストで約 2 倍遅くなるという報告、video は 3 分 → 4 分超（133%）の報告がある（いずれも issue の報告で、環境依存）。
- **CI は `workers: 1` から始める**。Playwright 公式の CI ガイド自身が CI では 1 worker を推奨し、広い並列化は sharding で行う。D1 はデータベース単位で単一スレッド、DO は単一インスタンスで直列化するため、同一 state を共有したまま worker を増やすと待ち行列で flake になる。
- **テスト管理は「小さく始めて、計測してから製品を買う」**。Phase 1 は Playwright 標準（blob + html + junit、retry 1、quarantine ファイル、owner、14 日 SLA）で足りる。flaky 率・CI 時間・所有が回らなくなった時点で Currents / Datadog / Trunk / Buildkite を検討する（各社の quarantine モデルは §7.4 の比較表）。

推奨 R1〜R7 の対応:

| 推奨 | 対応する未確定 | 一言 |
| --- | --- | --- |
| R1 実行環境 | U-01 | `cf dev` + 別プロセス Vite。readiness は `/ws` 401 か stdout の `Ready on`。 |
| R2 seed | U-02 | テスト専用 Worker の `/__e2e/seed`。製品 Worker の route は増やさない。 |
| R3 テスト管理 | U-06 | 1 サーバ + 一意 id、shard は journey ファイル単位、blob を merge。 |
| R4 flake 運用 | U-05 / U-06 | retry 1、quarantine ファイル + owner + 14 日 SLA、nightly で `failOnFlakyTests`。 |
| R5 reporter / artifact | U-06 | blob + html + junit、trace on-first-retry、video off、失敗時のみサーバログと state ダンプ。 |
| R6 性能 | U-07 | 起動 1 回・seed 1 回・待ちはイベント、trace/video を絞る、prebuild を共有。 |
| R7 移行条件 | U-01 / D065 | Vite plugin 採用・複数 Worker 同時起動・per-test reset が必要になったら再判定。 |

## 1. 調査方法と確度

- **一次資料**: リポジトリ内の実装・決定（D063 / D065、`tools/deploy/`、`packages/server/test/integration/`）、`node_modules/cf`（1.0.0-beta.28）のソース、Cloudflare 公式ドキュメント、Playwright 公式ドキュメント、各社の公式ドキュメント・ブログ。
- **実測**: このワークスペースで一時プロジェクト（`/tmp`）を作り、`cf dev` と Vite の起動時間・state の置き場所・複数インスタンスを確認した。リポジトリは変更していない。
- 表記: **確認済** = 一次資料または実測で確認、**推測** = 資料からの推定、**未確認** = 確認できていない。

## 2. Cloudflare `cf` CLI（1.0.0-beta.28）

### 2.1 `cf dev` の仕様（確認済）

`cf` は npm の `cf@1.0.0-beta.28`（`bin/cf`）。リポジトリではルートの devDependency で、`tools/deploy` から `../../node_modules/.bin/cf` を呼ぶ。

- **役割分担**: `cf` 自身は dev サーバも bundler も持たない。`cf dev` は (1) 対応 framework を検出すればその dev コマンドへ委譲し、`--mode` だけを転送する、(2) なければ `package.json` に宣言された Cloudflare のビルドツール（Wrangler 4.136.0 以上、または Cloudflare Vite plugin）へ委譲する（[Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/)）。
- **引数の転送**: framework 委譲時は `--mode` 以外を拒否（例: Vite プロジェクトで `cf dev --port 8788` は失敗）。ビルドツール委譲時は追加引数をそのまま渡す。実装上も `dev` は `implArgs` を positional で受け、`--mode` だけを別に組み立てて spawn する（`node_modules/cf/dist/dev-GsYHvMah.mjs`）。
- **`--persist-to`**: グローバル flag としては存在するが、**dev では明示的に拒否**される。cf のソースに `if (r === "dev" && i !== undefined) throw Error("--persist-to is not supported by cf dev.")` がある。公式ドキュメントも「`--persist-to` works only with `--local`」と明記（[cf projects](https://developers.cloudflare.com/cf/projects/)）。D065 / 0146 の記述は正しい。
- **`--local`**: dev では非対応（`--local is not supported by cf dev.`）。`cf d1 raw --local` などは「short-lived local runtime」を起動する別系統で、**dev サーバのデータとは共有されない**（公式ドキュメントに明記）。したがって「`cf d1` で dev の D1 を直接 seed する」はできない。
- **mode**: `--mode` は必須（hns の `modes.ts` が `undefined` を拒否）。Wrangler 経由のビルドでは mode の既定は `undefined`、Vite 経由では dev=`development` / build=`production`。
- **local state**: dev サーバのデータは **プロジェクト内の `.wrangler/state/v3`**。`XDG_CONFIG_HOME` 配下には `.wrangler/{logs,registry,metrics.json}` が置かれる（実測、§2.3）。公式ドキュメントの「Cloudflare Vite plugin 2.0 beta は `.cloudflare/state/` に置く」は Vite plugin 経由の場合で、Wrangler 経由の hns とは別（[cf projects](https://developers.cloudflare.com/cf/projects/)）。
- **ログ / 調査**: dev サーバは local URL を表示し、`/cdn-cgi/local/explorer`（Local Explorer）で binding データ・ログ・trace・Cron を検査できる（[cf projects](https://developers.cloudflare.com/cf/projects/)）。E2E の失敗調査で使える。
- **起動プロファイル**: `cf workers check` が bundle size と startup timings を JSON で出し、`worker-startup.cpuprofile` を書く（同上）。E2E ではなく性能調査に使う。

### 2.2 `cf dev` の起動・待ち合わせ・複数インスタンス

実測（このワークスペース、`/tmp` の一時プロジェクト、wrangler は `tools/deploy/node_modules` を symlink）:

| 条件 | 最初の 200 までの時間 |
| --- | --- |
| 空の Worker（text binding のみ） | **2216 ms** |
| D1 binding あり | **2220 ms** |
| 2 個目のインスタンスを同時起動（別 dir・別 port・D1 あり） | **2015 ms** |

- 起動ログは `⎔ Starting local server...` → `[wrangler:info] Ready on http://localhost:<port>`。最初のリクエストは 150〜215 ms、2 回目以降は 3〜5 ms。
- **複数インスタンスは可能**。別プロジェクトディレクトリ + 別ポート + 別 XDG で 2 つ同時に起動し、両方 200 を返すことを確認。state も別ファイルになった。
- **ポート**: hns の既存 integration は `cf dev --mode development --port <free>` で空きポートを渡す（`packages/server/test/integration/session-do.test.ts`）。wrangler へ委譲されるため `--port` が通る。framework（Vite）を検出すると通らないので、E2E 用プロジェクトに Vite を入れないこと。
- **readiness**: 既存 harness は `/health` を 100 ms 間隔で poll し、40 秒でタイムアウト、子プロセスの exit を検知したらログ付きで失敗する。プロセスは `detached: true` で起動し、`process.kill(-pid, "SIGTERM")` → 5 秒で SIGKILL。**この形を E2E fixture にそのまま流用できる**。
- **programmatic 起動**: `cf dev` に「起動して URL を返す」API はない。子プロセス + readiness poll が正攻法。Playwright の `webServer` も使える（`cwd` / `env` / `wait: { stdout: /Ready on/ }` / `gracefulShutdown`）が、テストごとの state 切替と seed を考えると fixture で所有する方が素直（§5）。

### 2.3 state の置き場所（実測、重要）

`cf dev` を `XDG_CONFIG_HOME=<dir>/config` で起動したときの実際の配置:

| パス | 中身 |
| --- | --- |
| `<project>/.wrangler/state/v3/{d1,do,r2,kv,cache,observability}` | **D1 / DO SQLite / R2 / KV の実体** |
| `<project>/config/.wrangler/{logs,registry}` | ログ、registry（XDG_CONFIG_HOME 側） |

つまり **`XDG_CONFIG_HOME` を分けても D1/DO は分離されない**。分離の単位はプロジェクトディレクトリ。既存の integration が `mkdtemp` でプロジェクトを作っているのはこのため（`session-do.test.ts` の `writeProject()`）。0043 の設計にある「XDG を run ごとに分ける」だけでは不十分で、**「同じサーバを共有し、データは一意な id で分ける」か「プロジェクトごと分ける」**のどちらかを選ぶ必要がある（§5 で推奨）。

なお `cf dev` は起動時に `.cloudflare/types/index.d.ts` を再生成する（ログ: `Regenerated .cloudflare/types/index.d.ts`）。リポジトリの `tools/deploy` で回すと working tree が動くので、E2E では生成先を一時プロジェクトにするか、生成物を追跡済み・差分なしに保つ運用が要る（**確認済**、実測ログ）。

### 2.4 hns の現在の cf の使い方

- `tools/deploy/cloudflare.config.ts` が `defineConfig(({ mode }) => ...)` で 1 Worker を定義。`Session` / `Workspace` の DO export、`DB`（D1）、`OBJECTS`（R2）、`GATEWAY`（別 Worker への service binding）を持つ。**1 つの `cloudflare.config.ts` = 1 Worker**。
- `tools/deploy/modes.ts` が `--mode` を必須にし、development だけ既定（agent URL `http://127.0.0.1:8788`、model `faux/echo`）を持つ。
- `docs/engineering.md` §配備: `cd tools/deploy && XDG_CONFIG_HOME=... XDG_CACHE_HOME=... cf dev --mode development`。`--persist-to` は使わない。gate の deploy stage は `cf deploy --dry-run --mode development`。
- 既存 integration の cf 起動は §2.2 のとおり。gateway は別プロジェクトで、テスト専用 Worker が実モジュール + `MIGRATIONS` を D1 に適用し、`/seed` で行を書く（`packages/server/test/integration/gateway/harness.ts`）。**この「テスト専用 Worker + 実 D1」の型が 0043 の seed にそのまま使える**（§6）。

### 2.5 `cf dev` の落とし穴（E2E 設計に効くもの）

1. **framework 検出**: E2E 用プロジェクトに `vite` を入れると `cf dev` が `npx vite` に委譲し、`--port` が通らなくなる。実測では次のエラーになった: 「Arguments cannot currently be forwarded to the detected dev command `npx vite`. Run that command directly with the required arguments.」（確認済。`vite` を devDependency に足しただけで検出された）。UI の Vite は別プロセスにする。
2. **1 プロジェクト 1 Worker**: edge と gateway を同時に 1 つの `cf dev` で動かすことはできない。service binding のローカル解決は未確認（§8.3）。E2E の Phase 1 は gateway を経由しない経路（または HTTP の fake）に限定するのが安全。
3. **state はプロジェクト内**: 「XDG を分ける」だけでは分離できない（§2.3）。
4. **生成物**: `cf dev` が `.cloudflare/types/index.d.ts` を書き換える。
5. **`cf dev` は `package.json` の script を実行しない**。ビルドは各自で行う（公式ドキュメント）。
6. **npm workspace 内の一時プロジェクト**: lockfile が無いと `No lock file has been detected ... Auto-configuration of projects inside workspaces is limited.` が出る（実測）。`cloudflare.config.ts` があれば自動構成は走らないので実害は無いが、ログが汚れる。E2E の一時プロジェクトには最小の `package.json` と `node_modules` を置く（既存 integration と同じ）。

## 3. 実行環境の比較（cf dev / wrangler / Miniflare / vitest / createTestHarness）

Cloudflare の公式なテスト手段は 3 層ある（[Testing](https://developers.cloudflare.com/workers/testing/)）: (1) **Workers Vitest integration**（`@cloudflare/vitest-plugin`、テスト自体が workerd 内で走る）、(2) **`createTestHarness()`**（Wrangler の API。1 つ以上の Worker を 1 サーバで起動する integration 用）、(3) **Miniflare**（programmatic なローカル runtime）。`unstable_dev` は非推奨で、Vitest integration か `createTestHarness` へ移行する（[Migrate from unstable_dev](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-unstable-dev/)）。

| 手段 | 実体 | 複数 Worker | テストごとの state | 起動コスト | browser E2E | D065（cf 統一） | hns での適性 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **`cf dev`** | wrangler（内部で Miniflare/workerd） | 不可（1 config = 1 Worker） | プロジェクト単位。サーバ再起動 + dir 削除でリセット | 実測 2.0〜2.2 s | 可（Vite と併用） | **適合** | **E2E の主経路（推奨）** |
| `wrangler dev` 直接 | 同上 | 不可 | 同上 | 同上 | 可 | 禁止（D065） | 使わない |
| **Miniflare** | programmatic workerd | `workers` / `serviceBindings` で可 | `persist` dir を分ける | 数十〜数百 ms（起動のみ） | 不可（HTTP のみ） | CLI ではないので抵触しない | integration / store の既存手段 |
| **`@cloudflare/vitest-plugin`**（旧 vitest-pool-workers） | Vitest が workerd 内で実行 | 可（`workers`） | **テストファイル単位**（`--max-workers=1 --no-isolate` で共有） | Vitest の起動 + workerd | 不可 | ライブラリ | unit / integration 向き。E2E には不足 |
| **`createTestHarness()`** | Wrangler API。production build を 1 サーバで | **可**（`workers: [...]`） | `server.reset()` で storage 再作成 | 数百 ms（推定） | **Playwright fixture 例あり** | wrangler API（CLI ではない） | 将来の有力候補。cf プロジェクトとの接続が未確認 |

補足（すべて確認済、公式ドキュメント）:

- Vitest integration の isolation は **テストファイル単位**。storage を共有したい integration は `--max-workers=1 --no-isolate`（[Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/)）。
- `createTestHarness()` は `server.listen()` / `server.reset()` / `server.getWorker().getEnv()` / `applyD1Migrations()` / `getDurableObjectStorage()` / `bindingOverrides` / `server.debug()` を持ち、**Playwright の fixture 例**（`baseURL` を harness の URL にし、失敗時に `server.debug()`、afterEach で `reset()`）が公式にある（[Integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/)、[Integrations](https://developers.cloudflare.com/workers/testing/test-harness/integrations/)、[Prepare test state](https://developers.cloudflare.com/workers/testing/test-harness/prepare-test-state/)）。
- Miniflare は hardened sandbox ではない（[Testing](https://developers.cloudflare.com/workers/testing/)）。E2E で製品コードを動かすのは問題ないが、信頼できないコードを動かさない。

**E2E にどれを使うか（結論）**: D065 の下では **`cf dev` + 別プロセス Vite + Playwright**。`createTestHarness` は「複数 Worker・per-test reset・直接 seed」を 1 つで解決するため将来の有力候補だが、**`cloudflare.config.ts`（cf）プロジェクトを直接読めるかが未確認**（Wrangler 設定ファイル前提の API）。D065 を変える判断は 0043 ではしない。R7 の再判定条件に入れる。

## 4. Workers / DO / D1 のテストパターンと E2E への影響

### 4.1 公式パターン

- **unit**: Vitest integration（workerd 内、binding 直接）。
- **integration**: `createTestHarness()`（複数 Worker、production build、外部 fetch は Node の `globalThis.fetch` を経由するので MSW / `vi.spyOn` で差し替え可能）。
- **E2E**: 公式に「Playwright と組み合わせる」例がある（上記 Integrations）。ただし Cloudflare 自身は E2E ランナーを提供していない。
- **seed**: `createTestHarness` は「binding 経由で直接 storage に書く」「D1 migration を適用して行を入れる」「DO の SQLite に SQL を実行する」を公式サポート。hns の既存 integration は「テスト専用 Worker の route + 実モジュール + migration」で同じことを達成している。

### 4.2 DO / D1 が E2E の性能・分離に与える影響

- **D1 はデータベース単位で単一スレッド**。公式に「Each individual D1 database is inherently single-threaded, and processes queries one at a time」と明記（[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)）。1 ms のクエリなら 1000 qps が上限。E2E で同じ DB を共有して並列に叩くと、待ち行列がテスト時間に出る。
- **DO は 1 インスタンスが直列**。`blockConcurrencyWhile` と input/output gate により、同じ DO 名への同時リクエストは直列化される。hns は 1 project = 1 Session DO / 1 Workspace DO（D049 以降）なので、**同じ project を使う 2 テストを並列にすると必ず直列化する**。テストごとに project を作る（= DO 名を分ける）のが正しい。
- **DO の SQLite は 10 GB / object、CPU 30 s/request**（[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)）。E2E の 1 テストで大量の履歴を作らない。
- **service binding**: ローカルで別 `cf dev` の Worker を service binding で解決できるかは**未確認**。公式には remote binding / remote service binding の説明はあるが、ローカル 2 プロセス間の service binding の明示的な記述は見つからない。Phase 1 は GATEWAY を通らない経路にする（§8.3）。
- **D1 の local latency**: 実測で最初のクエリを含むリクエストが 150〜215 ms、以降 3〜5 ms（§2.2）。**最初の 1 回だけ D1/DO の初期化コスト**が乗る。per-test にサーバを再起動するとこのコストを毎回払う。

### 4.3 seed の既存例（hns 内）

- **テスト専用 Worker 経由**（gateway）: `/seed` が `MIGRATIONS` を D1 に適用し、`bindings` 経由で行を書く。製品 Worker には route を足さない。**推奨の型**。
- **テスト専用 Worker + DO RPC**（session-do）: `/t/...` が Session DO に転送され、`create/send/list` を実行。E2E の seed もこの形で「会話・project・workspace ファイル」を作れる。
- **env-gated の製品 route**（0043 の案）: `HNS_E2E=1` のときだけ `/__e2e/seed`。実装は簡単だが、製品 Worker の route 表と秘密の扱いが増える。**本番 404 を固定するテストが必須**。
- **direct D1**: `cf d1` は dev の state を見ない（§2.1）。dev の state ファイルを sqlite3 で直接開くのは wrangler の内部形式に依存するので**やらない**。

## 5. テストごとの state 分離（U-01 / U-07 の核心）

### 5.1 選択肢

| 方式 | 分離度 | 1 テストの追加コスト | D1/DO/R2 | 向くテスト |
| --- | --- | --- | --- | --- |
| **A. テストごとに一時プロジェクト + `cf dev`** | 完全（D1/DO/R2/ログすべて別） | 起動 2.0〜2.2 s + port + teardown | 完全に別 | 再起動・永続・破壊的操作、nightly の一部 |
| **B. 1 サーバ + テストごとに一意な id** | 論理（行・DO 名が別） | HTTP 1〜2 回（seed）+ 数十 ms | 共有（直列化に注意） | ほぼ全部（推奨の既定） |
| **C. 1 サーバ + テスト後に state を削除して再起動** | 完全に近い | 2.0 s × N + 削除 | 別 | A の簡易版。壊れやすいので非推奨 |
| **D. `createTestHarness` の `reset()`** | 完全（storage 再作成） | 数百 ms（推定） | 完全に別 | 将来。cf プロジェクト接続が未確認 |

### 5.2 推奨（R1 / R6）

1. **既定は B**。Playwright の worker ごとに `cf dev` を 1 つ起動し（Phase 1 は `workers: 1` なので 1 つ）、テストは `runId` + `testId` を含む一意な id で user / project / conversation / workspace を作る。D1 の行も DO 名も衝突しない。
2. **A は「サーバ再起動・永続・復旧」を見るテストだけ**に使う（例: WS 再接続、DO の再起動後復帰、migration）。テストファイルを分け、`test.describe.configure({ mode: "serial" })` で直列にし、専用の一時プロジェクト + 空きポートで起動する。既存の `session-do.test.ts` の `writeProject()` / `start()` / `stop()` を fixture 化すればよい。
3. **分離の単位はディレクトリ**（§2.3）。XDG だけ分けても D1/DO は分かれない。nightly では `runId` ごとのプロジェクト dir を作り、終了時に削除する。
4. **state の掃除**: DO の object は「削除 API」が基本ない。テストで作った project は seed API の `DELETE /__e2e/run/<runId>` で D1 行と R2 object を消し、DO は `deleteAll()` を seed Worker から呼ぶ。消し漏れは nightly のディレクトリ破棄で回収する。**「テストは消さない、run ごとに捨てる」**が最も壊れにくい。

### 5.3 並列度の決め方

- **Phase 1**: `workers: 1`、`fullyParallel: false`。Playwright 公式の CI ガイドも CI では 1 worker を推奨（[Continuous Integration](https://playwright.dev/docs/ci)）。理由は「安定性と再現性」で、D1 単一スレッド・DO 直列化という hns の事情とも一致する。
- **Phase 2**: 並列化は **shard**（別ジョブ = 別 `cf dev` = 別 state）で行う。1 ジョブ内の worker を増やすと state を共有して直列化するため、効果が読みにくい。
- **shard 数**: journey ファイル数と CI の分単位コストで決める。まず 2、nightly で 4。各 shard の固定費は `cf dev` 2.2 s + Vite 0.25 s + browser 起動（推定 0.3〜0.5 s）なので、4 shard でも 15 s 程度。テスト本体が数分あるなら割に合う。

## 6. seed の設計（U-02）

### 6.1 方式の比較

| 方式 | 製品コードへの影響 | 速度 | 型安全 | 失敗時の診断 | 推奨 |
| --- | --- | --- | --- | --- | --- |
| UI でセットアップ | なし | 遅い（数秒〜） | 弱い | 画面に依存 | 使わない（0043 の方針どおり） |
| **テスト専用 Worker の HTTP route** | **なし**（別プロジェクト） | 速い（1 request） | 中（JSON を parse） | サーバログ + レスポンス | **R2 の推奨** |
| 製品 Worker の env-gated route | あり（route 表・秘密） | 速い | 中 | 同上 | 次点。本番 404 の固定が必須 |
| DO RPC 直叩き | なし（test Worker 経由） | 速い | 強い | RPC のエラー | 併用（会話・workspace） |
| direct D1（`cf d1` / sqlite3） | なし | 速い | 弱い | 不明 | **不可**（dev の state を見ない / 内部形式依存） |

### 6.2 推奨（R2）

- `e2e/worker/` に **テスト専用の cf プロジェクト**を置く（`cloudflare.config.ts` + `worker.ts`）。本物の `@hns/server` / `@hns/store` のモジュールを import し、実 D1 / 実 DO に対して:
  - `POST /__e2e/seed`: body `{ runId, testId, user?, project?, conversation? }` → `{ userId, projectId, conversationId, cookie }` を返す。migration は起動時に 1 回だけ適用（`schema_migrations` で冪等）。cookie は製品と同じ `HNS_SESSION_SECRET` で署名し、**ログインの UI ジャーニー以外は storageState に直接入れる**。
  - `POST /__e2e/reset`: run の行・object を削除（nightly 用）。
  - `GET /health`: 200（readiness 用）。
  - 認証: 起動ごとにランダムな `E2E_SEED_TOKEN` を env で渡し、`authorization` を照合。無ければ 404。
- 製品 Worker の route は増やさない。0043 の「`HNS_E2E=1` で `/__e2e/seed`」案を採る場合でも、**route の登録自体を env で行い、未設定時は 404** を固定するテストを C6 に置く（0043 の C6 はそのまま使える）。
- seed は **1 テスト 1 呼び出し**にまとめる。UI で user を作る・project を作るを繰り返さない。返ってきた id をすべてテストデータに入れ、後続の API 呼び出しやアサーションに使う。
- **一意性**: `runId = E2E_RUN_ID ?? <timestamp>-<pid>`、`testId = testInfo.testId` を使い、`e2e-<runId>-<testId>-<連番>` を user / project / conversation の名前にする。**shard をまたいでも衝突しない**。日付や乱数だけにしない。
- **cleanup**: 既定は「消さない」（失敗時の調査に残す）。nightly の最後に run 単位で削除。CI の state はジョブ終了で捨てる。

### 6.3 seed のアンチパターン

- テスト間で同じ user / project を共有する（passkey の登録状態・DO の直列化・一覧のページングが干渉する）。
- seed で UI を操作する（失敗箇所が 2 つになる）。
- `sleep` で seed の完了を待つ（seed は同期の HTTP で完了させる）。
- 本番の秘密を E2E の artifact に入れる（storageState に provider 鍵を入れない、0043 の決定 4 のとおり）。

## 7. E2E のテスト設計・管理・運用

### 7.1 Playwright の作法（公式、確認済）

- **ユーザーに見える振る舞いをテストする**。実装の詳細（関数名・CSS クラス）を避け、role / label / text の locator を使う（[Best Practices](https://playwright.dev/docs/best-practices)）。
- **テストは完全に分離**。各テストは自分の local storage / cookie / data を持ち、前のテストに依存しない（[Best Practices](https://playwright.dev/docs/best-practices)、[Isolation](https://playwright.dev/docs/browser-contexts)）。Playwright はテストごとに BrowserContext を作る。
- **fixture で setup/teardown を 1 箇所に**。on-demand・composable・再利用可能（[Fixtures](https://playwright.dev/docs/test-fixtures)）。hns の `e2e/fixtures/` はこの単位（server, seed, auth, run）。
- **認証は setup project + `storageState`**。ログインを 1 回だけ行い、各テストは保存済み state で開始する。state ファイルは `.gitignore`（[Authentication](https://playwright.dev/docs/auth)）。**サーバ側の状態を変更するテストが並列なら、ユーザーを分ける**（同 docs の "When not to use"）。
- **projects** でブラウザ・環境・タイムアウト・retries を分ける。hns は chromium のみ、`setup`（認証）→ `chromium` の依存にする（[Projects](https://playwright.dev/docs/test-projects)）。
- **web-first assertion** と auto-wait。`expect(locator).toBeVisible()` などを使い、固定 sleep を書かない（[Best Practices](https://playwright.dev/docs/best-practices)）。
- **timeout の階層**: test 30 s（既定）、expect 5 s（既定）、`globalTimeout` を必ず設定（CI でハングしてもレポートが出る）（[Timeouts](https://playwright.dev/docs/test-timeouts)、[Continuous Integration](https://playwright.dev/docs/ci)）。
- **trace は `on-first-retry`** が公式の推奨。`on` は「performance heavy」で非推奨（[Trace viewer](https://playwright.dev/docs/trace-viewer)）。video は既定 off、`on-first-retry` / `retain-on-failure` を選べる（[Videos](https://playwright.dev/docs/videos)）。
- **retries は「失敗を隠す」ためではなく診断のため**。Playwright は初回失敗→retry 成功を `flaky` と分類する（[Retries](https://playwright.dev/docs/test-retries)）。`testInfo.retry` で retry 時だけ state を消す処理を書ける。
- **sharding** は `--shard=i/N`。`fullyParallel: true` ならテスト単位、既定はファイル単位で、**ファイルが均等でないと偏る**。statically skipped なテストは数えない。レポートは blob reporter で集めて `merge-reports`（[Sharding](https://playwright.dev/docs/test-sharding)）。
- **CI では `workers: 1`** を推奨（公式）。`forbidOnly`、`retries`、`globalTimeout` を設定する（[Continuous Integration](https://playwright.dev/docs/ci)）。
- **reporters**: `blob`（CI、merge 用）+ `html`（人が読む）+ `junit`（CI 連携）。`onlyFailures` で失敗だけに絞れる（[Reporters](https://playwright.dev/docs/test-reporters)）。
- **webServer**: `command` / `cwd` / `env` / `url`（2xx,3xx,400,401,402,403 で ready） / `wait`（stdout の regex、名前付き group を env に保存） / `gracefulShutdown` / `timeout` / 複数指定（[Web server](https://playwright.dev/docs/test-webserver)）。

### 7.2 テスト名・ジャーニー・ページオブジェクト

- **1 テスト = 1 ジャーニー**（0043 の決定どおり）。名前に issue 番号や実装名を入れず、「ユーザーが何をできるか」を書く。例: `"a signed-in user sends a message and sees the reply stream"`。
- **タグ**で実行範囲を分ける: `@smoke`（PR、3 本）、`@nightly`（全部）、`@slow`。Playwright の `tag` と `--grep` / `--grep-invert` を使う（[Annotations](https://playwright.dev/docs/test-annotations)）。quarantine は `@quarantine` を付けて PR ジョブから除外し、nightly で実行する。
- **ページオブジェクト**は「画面」単位（`e2e/pages/`）。操作とアサーションを分け、**ジャーニー固有の手順は journey 側に置く**。POM にシナリオを埋め込むと、複数ジャーニーで再利用できなくなる（[Page object models](https://playwright.dev/docs/pom)）。hns の UI は画面単位（0101 以降）なので、`pages/` を画面名に合わせる。
- **fixture** は「サーバ」「seed」「認証」「run」の 4 つに絞る。fixture 同士の依存は 1 方向（run → server → seed → auth）。
- **テストデータの一意性**: §6.2 の `runId` + `testId`。ファイル名・表示名にも入れて、失敗時の artifact からどの run か分かるようにする。
- **cleanup**: 既定は残す。削除は run 単位の API。`afterEach` で毎回消すのは、失敗調査を難しくするので避ける（Isolation の「start from scratch か cleanup か」で、E2E は start from scratch = 一意 id を選ぶ）。

### 7.3 sharding / quarantine / artifact / reporter / CI（R3 / R5）

| 項目 | Phase 1（PR / ローカル） | Phase 2（main / nightly） |
| --- | --- | --- |
| 実行 | `npm run test:e2e`（ローカル）、`@smoke` 3 本 | 全ジャーニー |
| workers | 1 | 1 / shard |
| shards | 1 | 2 → 4（journey ファイル単位、`--shard=i/N`） |
| retries | 1（CI のみ。ローカル 0） | 1 |
| trace | `on-first-retry` | `on-first-retry`（flake 調査中は `retain-on-failure`） |
| video | off | off（必要なら該当テストだけ `test.use({ video: "on" })`） |
| screenshot | `only-on-failure` | 同 |
| reporters | `list` + `html` | `blob` + `html` + `junit`、`merge-reports` で統合 |
| artifact | trace / screenshot / サーバログ / seed 応答 / seed した id 一覧 | 同 + D1 の該当行ダンプ（seed API 経由） |
| retention | 7 日 | 14 日（flake 調査用） |
| quarantine | 実行しない | `@quarantine` を nightly で実行、結果を記録 |
| 失敗の扱い | `failOnFlakyTests` は false | nightly は `true`（flake を可視化） |

- **サーバログ**: `cf dev` の stdout/stderr をファイルに落とし、失敗時に artifact へ。request id（`x-request-id`）とテストの開始/終了を同じファイルに出すと突き合わせやすい。
- **state ダンプ**: D1 の行は seed Worker の `GET /__e2e/dump?runId=...` で JSON に。DO は `getDurableObjectStorage` 相当の RPC を seed Worker に置く。**sqlite ファイルを直接 artifact に入れない**（内部形式・サイズ）。
- **CI キャッシュ**: `~/.npm` / `node_modules`（lock の hash）、`~/.cache/ms-playwright`（Playwright の version を key）、`packages/*/dist` と `.cloudflare/output`（source の hash）。**shard ごとに build しない**。prepare ジョブで 1 回 build し、artifact を各 shard に配る（既存 integration は 3 パッケージを毎回 build しており、最大 90 s × 3 の timeout を持つ。E2E ではこれを共有する）。
- **shard の割り方**: journey ファイルを小さく均等に。`fullyParallel: true` はテスト単位で配れるが、**同じファイル内でサーバ state を共有しない**ことが前提。Phase 1 はファイル単位のままでよい。

### 7.4 flaky 管理製品の比較（既製品）

| 製品 | 検出の前提 | 状態モデル / quarantine | 自動化 | 所有・チケット | 期限・SLA | 依存 / 費用 | hns への示唆 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Cypress Cloud** | retries が必須。初回失敗→retry 成功を flaky として記録 | 組み込みの quarantine は**ない**。「parked」ディレクトリ + Run Checks の `include`/`exclude` でゲートから外す（テストは実行され続ける） | Flake Alerting、Branch Review（new / existing / resolved）、Test Replay | テスト単位の所有は無し（Branch Review はレビュアー向け） | なし | Cypress 専用。Team 以上 | **Playwright にはそのまま使えない**が、「quarantine しても実行は続ける」「branch 差分で new/existing を分ける」は採用価値が高い |
| **Currents** | retries + 初回失敗で flaky。Test Explorer で flakiness 率 | quarantine 機能はなし（flake の可視化と orchestration が中心） | Test Orchestration（履歴ベースの動的配分、最大 40% の CI 時間短縮の事例）、`failOnFlakyTests` 連携 | なし | なし | Playwright/Cypress の reporter。SaaS | **shard の偏り**を履歴で直す発想。Phase 2 で shard 数が増えたら検討 |
| **Trunk Flaky Tests** | 言語・FW 非依存。JUnit を取り込む | quarantine（自動 / 手動）、**never quarantine** の指定、broken（常時失敗）と flaky を区別 | 自動 quarantine、チケット自動作成・再オープン・クローズ | **CODEOWNERS から owner を引く**。Linear / Jira / Asana | チケットのライフサイクルで追う。固定 SLA は製品外 | SaaS | **owner を CODEOWNERS から引く**、never quarantine（smoke は絶対に外さない）が参考 |
| **Datadog CI Visibility** | テストイベント。fingerprint = repo ID + FQN | **Active / Quarantined / Disabled / Fixed** の 4 状態。Quarantined は「実行するが CI を落とさない」、Disabled は「実行しない」 | **ポリシー**: default branch で flake したら自動 quarantine、30 日直らなければ disable。Jira 起票 | なし（Jira 連携） | **30 日で disable** が既定の例 | Datadog 契約。SaaS | **状態を 4 つに分ける**（quarantine と disable は別）、**期限で自動エスカレーション**が参考 |
| **Buildkite Test Engine** | テストイベント | **enabled / muted / skipped**。**mute 推奨**（実行は続け、失敗はビルドに影響しない） | Workflow の Change state で自動 quarantine / recover。`bktec` で実行をスキップ | テストスイート単位の権限 | なし | Buildkite 契約 | 「mute（実行する）を既定、skip は最終手段」は hns の Phase 1 にそのまま使える |

**読み取れる設計原則**（確認済の範囲）:

1. **quarantine は「実行を止める」ではなく「ゲートから外す」**。実行を続けると証拠が溜まり、回復を自動検出できる（Trunk / Datadog / Buildkite / Slack が一致）。
2. **状態を分ける**（active / quarantined / disabled / fixed）。hns は Phase 1 では `@quarantine` タグ + ファイルで表現し、状態を 2 つ（quarantine / 通常）に保つ。Disabled は「削除予定」として issue で扱う。
3. **owner と期限**がないと quarantine は墓場になる。Trunk は CODEOWNERS、Slack はチーム所有マップ + Jira、Datadog は 30 日で disable。
4. **自動化は最後**。まず検出（retries + nightly）と可視化（flake 率）がないと、自動 quarantine は回らない。

### 7.5 大企業の flaky 運用（データ付き）

| 組織 | 公表されている数値・運用 | 出典 |
| --- | --- | --- |
| **Google (2016)** | 全テスト実行の約 **1.5%** が flaky。**16%** のテストに flakiness がある。pass→fail の遷移の **84%** は flaky テストが関与。flaky 指定は「3 回連続失敗で初めて失敗扱い」。flaky の修正または削除を求める | [Flaky Tests at Google and How We Mitigate Them](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html) |
| **Google (2017)** | 420 万テストのうち週 6.3 万（<2%）が flaky。サイズ別では small **0.5%** / medium **1.6%** / large **14%**。バイナリサイズ・RAM 使用量が flakiness と強く相関（r²=0.82 / 0.76）。**大きいテストほど flaky** | [Where do our flaky tests come from?](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html) |
| **Uber (2024)** | flaky 管理を中央集権化（Testopedia）。テストを **FQN** で識別し、**FSM**（new / stable / unstable / disabled / deleted）で状態管理。Go monorepo で 60 万テスト中 1000、Java monorepo で 35 万中 1000 の flaky。flaky テストは非ブロッキングで実行し、Jira で通知 | [Flaky Tests Overhaul at Uber](https://www.uber.com/us/en/blog/flaky-tests-overhaul/)（本文は JS 描画のため要約は [engineering.fyi](https://www.engineering.fyi/article/flaky-tests-overhaul-at-uber) を参照。**数値は二次資料**） |
| **Slack (2022)** | 自動検出・抑止の導入前は main の pass 率が約 **20%**、失敗ビルドの **57%** がテストジョブ失敗。導入後はテストジョブ失敗が **5% 未満**、目標は main 95%。**1 件の手動トリアージに約 28 分**。テスト所有マップ → 所有チームへ Jira、週次のサマリ通知、自動で再有効化 | [Handling Flaky Tests at Scale](https://slack.engineering/handling-flaky-tests-at-scale-auto-detection-suppression/) |
| **Microsoft** | VS Code: **flaky は ASAP disable**。retry は長期運用に使わない。timeout は本質的に flaky → polling。ローカルで 100 回ループして再現。trace を artifact に。Aspire: `[QuarantinedTest]` 属性 + issue リンク、通常 CI から除外、**quarantine CI を 1 日 2 回**、失敗は PR をブロックしないが追跡。Azure DevOps: rerun で flaky を検出し、branch 単位で状態を共有、flaky を理由にビルド失敗を防ぐ設定 | [VS Code wiki](https://github.com/microsoft/vscode/wiki/Dealing-with-Test-Flakiness)、[Aspire quarantine](https://github.com/microsoft/aspire/blob/main/docs/quarantined-tests.md)、[Manage flaky tests](https://learn.microsoft.com/en-us/azure/devops/pipelines/test/flaky-test-management?view=azure-devops) |

hns への含意（**推測を含む**）:

- E2E は「大きいテスト」なので flaky 率は unit より高い（Google の large=14% は極端だが方向は同じ）。**E2E の本数を絞る**ことが最大の flake 対策（0043 の「単体・結合・契約で代替できないものだけ」と一致）。
- 小さなチーム（hns は実質 1〜2 人 + エージェント）では、Slack の「28 分/件」を前提にすると、**quarantine の自動化より「入れない」方が効く**。retry 1、trace、owner、14 日 SLA で始める。
- **smoke は never quarantine**（Trunk の概念）。PR を守る 3 本は flaky でも外さず、まず直す。nightly のジャーニーだけ quarantine 可。

## 8. 性能（起動・seed・並列・trace）

### 8.1 実測値と推定値

| 項目 | 値 | 確度 | 出所 |
| --- | --- | --- | --- |
| `cf dev` cold start（最初の 200 まで、空 Worker） | **2216 ms** | 実測 | 本調査（/tmp、1 回） |
| `cf dev` cold start（D1 binding あり） | **2220 ms** | 実測 | 同上 |
| 2 個目の `cf dev` 同時起動（D1 あり、別 dir/port） | **2015 ms** | 実測 | 同上 |
| 最初のリクエスト（D1 クエリ込み） | 150〜215 ms | 実測 | 同上 |
| 2 回目以降のリクエスト | 3〜5 ms | 実測 | 同上 |
| Vite 8.3.6 dev ready | **200〜250 ms** | 実測 | `packages/web` を一時 config で起動 |
| Vite の最初の module transform | 7〜8 ms | 実測 | 同上（main.tsx / App.tsx） |
| browser（Chromium）起動 | 0.3〜0.5 s | 推測 | Playwright の一般値。この環境に browser が無く未測定 |
| BrowserContext 作成 | 数 ms | 推測 | Playwright の設計（incognito 相当） |
| seed 1 回（HTTP + D1 batch + DO RPC） | 10〜50 ms | 推測 | local D1 の実測（3〜5 ms/query）から |
| trace（snapshots 有効） | action の多いテストで**約 2 倍** | 二次情報 | [playwright#44053](https://github.com/microsoft/playwright/issues/44053)（2026-11、snippet） |
| video 有効 | 3 分 → 4 分超（**133%**） | 二次情報 | [playwright#5350](https://github.com/microsoft/playwright/issues/5350)（snippet） |
| trace + video で CI が timeout した例 | あり | 二次情報 | [playwright#10281](https://github.com/microsoft/playwright/issues/10281)（snippet） |

**結論**: 起動（2.2 s + 0.25 s）は支配的でない。**テストごとにサーバを再起動すると 2.2 s × N が効く**（20 テストで 44 s）。trace を全テストで on にすると action の多いジャーニーで 2 倍、video はさらに重い。**「起動 1 回・seed 1 回・trace は失敗時だけ」**が最も効く。

### 8.2 コストの内訳（1 ジャーニーあたり、推定）

| 要素 | 目安 | 削減策 |
| --- | --- | --- |
| ページ表示（Vite の初回 transform） | 50〜300 ms | warm-up 用の 1 リクエストを globalSetup で打つ。Vite の `optimizeDeps` を事前に温める |
| seed | 10〜50 ms | 1 呼び出しにまとめる。UI で作らない |
| ログイン | 0（storageState 再利用） | setup project で 1 回だけ。passkey は仮想 authenticator |
| 会話のストリーミング | 数百 ms〜数秒 | faux model の応答を短く固定。**終端イベント**で待つ（sleep しない） |
| WS 再接続 | 数百 ms | 切断を明示的に作り、再接続の snapshot を待つ。hibernation は cf dev が再現しない（0159 の既知） |
| trace（on-first-retry） | retry したテストのみ | 失敗時だけ。`retain-on-failure` は flake 調査時のみ |
| サーバ再起動（方式 A） | 2.2 s / 回 | 永続・復旧テストだけに限定 |

### 8.3 hns 固有の性能・分離リスク

1. **D1 の単一スレッド**: 同一 DB を共有する並列テストは直列化する。テストごとに project を分けても DB は同じなので、**同時実行数 × クエリ数**が上限。Phase 1 の workers=1 はこれを避ける。
2. **DO の直列化**: 同一 project の Session DO に複数テストが触ると待つ。**project をテストごとに作る**（§6.2）。
3. **service binding（GATEWAY）**: 1 `cf dev` = 1 Worker。gateway を別 `cf dev` で起動しても、ローカルの service binding が別プロセスを解決する保証は**未確認**。Phase 1 は GATEWAY を使わない経路（faux model を Worker 内で直接、または HTTP の fake provider）にする。0152 で gateway を通すジャーニーを足すときに再検討。
4. **hibernation**: cf dev は DO を evict しない（0159 の Result に明記）。WS 再接続のテストは「切断 → 再接続」で作れるが、実際の hibernation wake は再現できない。**未確認のまま**にし、E2E で偽の合格を作らない。
5. **`x-request-id`**: すべてのレスポンスに付く（0145）。失敗時にサーバログと突き合わせる鍵にする。
6. **計測**: `cf workers check` で bundle size / startup を測れる（§2.1）。E2E の時間は Playwright の JSON reporter から test ごとに取り、**遅い上位 10 本**を issue 化する。

### 8.4 性能目標（提案）

| 指標 | Phase 1 目標 | Phase 2 目標 | 測り方 |
| --- | --- | --- | --- |
| PR の E2E（smoke 3 本）p50 | **< 60 s** | < 60 s | JSON reporter の duration |
| PR の E2E p95 | **< 120 s** | < 120 s | 同上 |
| nightly 全ジャーニー p50 | — | **< 8 分**（4 shard） | 同上 |
| 起動の占める割合 | < 10% | < 10% | 起動ログのタイムスタンプ |
| flaky 率（retry で救われたテスト / 全テスト） | < 2% | < 1% | `failOnFlakyTests` + JSON の集計 |
| 失敗テストの artifact 率 | 100% | 100% | trace / screenshot / log の有無 |

## 9. hns への推奨 R1〜R7

### R1（U-01）実行環境: `cf dev` + 別プロセス Vite + Playwright fixture

- **維持する**: `cf dev --mode development`（D065）。E2E 用の cf プロジェクトは `tools/deploy`（製品と同じ config）を既定にする。`XDG_CONFIG_HOME` / `XDG_CACHE_HOME` は run ごとに `work/e2e-state/<runId>/` へ（**ログ・registry 用**。D1/DO の state は `tools/deploy/.wrangler/state/v3` に残る）。データの分離は §5 の B（一意 id）で行い、run 単位の削除は seed API。**Vite は `packages/web` で別プロセス**にし、`tools/deploy/package.json` に vite を入れない（framework 検出を避ける）。
- **ポート**: 空きポートを 1 つ確保し、`cf dev --mode development --port <port>`。Vite は `--port <port+1> --strictPort`。`baseURL` は Vite、API は `/graphql` / `/ws` を Vite の `server.proxy` で cf dev へ（0160 の proxy 設定を使う）。
- **readiness**: `GET http://127.0.0.1:<port>/ws` が **401** を返すこと（`/graphql` は GET 405 なので不可）。または `cf dev` の stdout の `Ready on http://localhost:<port>` を待つ。既存 integration の `/health` は**テスト専用 Worker** にあり、製品 Worker には無い。製品に `/health` を足すかは 0043 の範囲外（必要なら別 issue）。
- **fixture**: `server`（cf dev）・`web`（Vite）・`seed`・`auth`・`run` の 5 つ。サーバは worker-scoped、`runId` は run-scoped。起動は `packages/server/test/integration/session-do.test.ts` の `spawn` + poll + `SIGTERM`（プロセスグループ）を流用する。
- **代替**: Playwright の `webServer` 配列（`cwd: tools/deploy`、`env`、`wait: { stdout: /Ready on/ }`、`gracefulShutdown`）でも起動できる。テストごとの state 切替と seed を考えると fixture 推奨。
- **受入**: C1（起動 → ログイン）が 60 秒以内、C8（`npm run check` に入らない）。

### R2（U-02）seed: テスト専用 Worker + 1 呼び出し

- `e2e/worker/` にテスト専用の cf プロジェクト（`cloudflare.config.ts`、`worker.ts`）。製品の `@hns/server` / `@hns/store` を import し、実 D1 / 実 DO に対して `/__e2e/seed` / `/__e2e/reset` / `/health` を提供。**製品 Worker の route は増やさない**。
- 認証は起動ごとの `E2E_SEED_TOKEN`。未設定・不一致は 404。**C6 で「env 無し → 404」を固定**（製品 route 案を採る場合も同じ）。
- seed の返り値: `{ runId, userId, projectId, conversationId, cookie, workspace }`。cookie は製品と同じ秘密で署名。ログインのジャーニーだけ UI を通す。
- migration は seed Worker の起動時に 1 回（`schema_migrations` で冪等）。テストごとには適用しない。
- **受入**: 1 seed = 1 HTTP、UI セットアップ 0、同じ run 内で id が衝突しない。

### R3（U-06）テスト管理: 1 サーバ + shard、blob を merge

- Phase 1: 1 shard / workers=1 / 3 smoke。Phase 2: journey ファイル単位で `--shard=i/N`（2 → 4）、各 shard が自分の `cf dev` + Vite + state dir を持つ。
- reporter は `blob`（CI）+ `html` + `junit`。`merge-reports` で 1 つの HTML に。artifact は trace / screenshot / サーバログ / seed 応答 / id 一覧。retention 7 日（nightly 14 日）。
- テスト名はユーザーに見える振る舞い。タグ `@smoke` / `@nightly` / `@slow` / `@quarantine`。issue 番号をテスト名・コードに入れない（AGENTS.md の規約）。
- **受入**: 3 本の smoke が PR で 2 分以内、nightly が 8 分以内、失敗時に trace が必ず残る。

### R4（U-05 / U-06）flake: retry 1、quarantine ファイル、owner、14 日 SLA

- `retries: process.env.CI ? 1 : 0`、`trace: "on-first-retry"`、`video: "off"`、`screenshot: "only-on-failure"`。
- `e2e/quarantine.json` に `{ test, owner, issue, quarantinedAt, expiresAt }`。PR ジョブは `--grep-invert @quarantine`。nightly は quarantine も実行し、**通ったら解除候補**としてレポート。期限切れは CI を落とす（Datadog の「30 日で disable」を 14 日に短縮した形）。
- smoke は **never quarantine**。落ちたら直すか、テストを消す（Google の「fix or delete」）。
- nightly のみ `failOnFlakyTests: true`（Playwright 1.52+ / `--fail-on-flaky-tests`）。PR は flake を理由に落とさない（まず計測）。
- owner は `work/BOARD.md` の担当ではなく、**ジャーニーごとの実装オーナー**（agent / user）を quarantine ファイルに書く。CODEOWNERS が入ったら Trunk 式に寄せる。
- **受入**: flaky 率が計測できる、quarantine の期限切れが CI で検出される、smoke に quarantine が付かない。

### R5（U-06）artifact / reporter / CI

- `playwright.config.ts` の骨子:

```ts
export default defineConfig({
  testDir: "e2e/journeys",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  globalTimeout: 20 * 60 * 1000,
  reporter: process.env.CI
    ? [["blob"], ["junit", { outputFile: "test-results/junit.xml" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "on-first-retry",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "setup", testMatch: /.*\.setup\.ts/ }, { name: "chromium", dependencies: ["setup"] }],
});
```

- CI は prepare（build + browser install + cache）→ shard ジョブ（`--shard=i/N`）→ merge（`merge-reports`）→ artifact upload。`npm run check` には入れない（0043 の受入どおり）。
- **受入**: merge 後の HTML に全 shard の結果が出る。artifact が 7 日残る。

### R6（U-07）性能

- サーバ起動は **1 回**（Phase 1）。テストごとの再起動は永続・復旧テストだけ。実測 2.2 s を N 回払わない。
- seed は 1 回。UI セットアップ禁止。ログインは storageState。
- 待ちはイベント（WS の終端 frame、`expect.poll`、web-first assertion）。`sleep` 禁止。WS は `page.waitForEvent("websocket")` とアプリの終端イベントを併用。
- trace は `on-first-retry`、video は off。必要なら `test.use({ video: "on" })` を該当テストだけ。
- build は prepare で 1 回。shard は artifact を受け取るだけ。`~/.cache/ms-playwright` を Playwright の version で cache。
- 計測は JSON reporter の duration を run ごとに保存し、遅い上位 10 本を週次で見る。`cf workers check` で Worker の startup を別途見る。
- **受入**: §8.4 の目標。起動の割合 < 10%。

### R7（U-01 / D065）移行条件（今は変えない）

以下が揃ったら D065 の再判定を行う:

1. **cf が Cloudflare Vite plugin を既定にする**（wrangler 依存を外せる）。このとき local state は `.cloudflare/state/` に移り、複数 Worker の同時起動が可能になる（公式ドキュメント）。E2E の state 分離・service binding の設計を見直す。
2. **複数 Worker（edge + gateway）を 1 プロセスで動かす必要**が出た（0152 の gateway ジャーニー）。`createTestHarness()` の `workers: [...]` が第一候補。ただし **cf の `cloudflare.config.ts` を読めるかが未確認**。読めないなら「テスト用の wrangler 設定を生成する」か「gateway を HTTP の fake にする」のどちらか。
3. **per-test の storage reset** が必須になった（テスト数が増え、一意 id では分離しきれない）。`createTestHarness().reset()` はこれを 1 API で提供する。
4. **E2E の本数が 30 を超える / flaky 率が 5% を超える**。このとき Currents（orchestration）や Datadog（状態 + 期限）を検討する。

## 10. 0043 の設計への具体的な差分

| 0043 の現在の記述 | 推奨する修正 |
| --- | --- |
| 決定 2「XDG を run ごとに分け、テスト間で汚さない」 | **XDG だけでは D1/DO は分かれない**。state はプロジェクト内 `.wrangler/state/v3`。1 サーバ + 一意 id を既定にし、完全分離は temp project。 |
| 決定 2「`cf dev --mode development` + Vite dev（0160 の proxy）」 | 維持。ただし **Vite を cf プロジェクトに入れない**（framework 検出で `--port` が通らない）。 |
| 決定 3「`HNS_E2E=1` のときだけ `/__e2e/seed`」 | **テスト専用 Worker** に置き、製品 Worker の route を増やさない。製品 route 案を採るなら「未設定で 404」を C6 で固定。 |
| 決定 5「retry は診断用に 1 回。flake は quarantine」 | 維持。**quarantine はタグ + ファイル + owner + 14 日 SLA**、smoke は never quarantine、nightly で `failOnFlakyTests`。 |
| 決定 6「PR はスモーク 3 本、main / nightly は全部」 | 維持。**PR は 1 shard / workers=1**、nightly で 2〜4 shard。 |
| 未確定 U-06「sharding / quarantine / artifact / reporter / CI キャッシュ」 | §7.3 の表で確定案を提示（R3 / R5）。 |
| 未確定 U-07「起動・seed・並列・trace のオーバーヘッド」 | §8 の実測 + 目標で確定案を提示（R6）。 |

## 11. 出典

### Cloudflare / cf

- [Cloudflare CLI overview](https://developers.cloudflare.com/cf/)
- [Develop, build, and deploy（cf dev / modes / --persist-to / Local Explorer / workers check）](https://developers.cloudflare.com/cf/projects/)
- [Testing（Vitest integration / createTestHarness / Miniflare の注意）](https://developers.cloudflare.com/workers/testing/)
- [Integration test harness（createTestHarness）](https://developers.cloudflare.com/workers/testing/test-harness/)
- [Get started（createTestHarness）](https://developers.cloudflare.com/workers/testing/test-harness/get-started/index.md)
- [Configure the test harness](https://developers.cloudflare.com/workers/testing/test-harness/configure/index.md)
- [Prepare test state（D1 migration / DO storage / bindingOverrides）](https://developers.cloudflare.com/workers/testing/test-harness/prepare-test-state/index.md)
- [Integrations（Playwright fixture の公式例）](https://developers.cloudflare.com/workers/testing/test-harness/integrations/index.md)
- [Vitest integration（`@cloudflare/vitest-plugin`）](https://developers.cloudflare.com/workers/testing/vitest-integration/index.md)
- [Isolation and concurrency（per-file storage）](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/index.md)
- [Migrate from unstable_dev](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-unstable-dev/index.md)
- [Local development](https://developers.cloudflare.com/workers/local-development/index.md)
- [D1 limits（単一スレッド）](https://developers.cloudflare.com/d1/platform/limits/index.md)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/index.md)

### Playwright

- [Best Practices](https://playwright.dev/docs/best-practices)
- [Fixtures](https://playwright.dev/docs/test-fixtures)
- [Isolation（BrowserContext）](https://playwright.dev/docs/browser-contexts)
- [Parallelism](https://playwright.dev/docs/test-parallel)
- [Sharding](https://playwright.dev/docs/test-sharding)
- [Retries](https://playwright.dev/docs/test-retries)
- [Reporters](https://playwright.dev/docs/test-reporters)
- [Timeouts](https://playwright.dev/docs/test-timeouts)
- [Annotations / tags](https://playwright.dev/docs/test-annotations)
- [Continuous Integration（workers=1、globalTimeout）](https://playwright.dev/docs/ci)
- [Authentication / storageState](https://playwright.dev/docs/auth)
- [Projects](https://playwright.dev/docs/test-projects)
- [Page object models](https://playwright.dev/docs/pom)
- [Web server](https://playwright.dev/docs/test-webserver)
- [Trace viewer（on-first-retry）](https://playwright.dev/docs/trace-viewer)
- [Videos](https://playwright.dev/docs/videos)
- [Test configuration](https://playwright.dev/docs/test-configuration)
- [CDPSession](https://playwright.dev/docs/api/class-cdpsession)
- 性能の二次情報: [playwright#44053](https://github.com/microsoft/playwright/issues/44053)、[playwright#5350](https://github.com/microsoft/playwright/issues/5350)、[playwright#10281](https://github.com/microsoft/playwright/issues/10281)

### flaky 管理製品

- [Cypress Cloud: Flaky Test Management](https://docs.cypress.io/cloud/features/flaky-test-management)
- [Cypress Cloud: Quarantine problematic specs](https://docs.cypress.io/cloud/guides/quarantine-problematic-specs)
- [Cypress Cloud: Load balancing](https://docs.cypress.io/cloud/features/smart-orchestration/load-balancing)
- [Currents: Flaky Tests](https://docs.currents.dev/dashboard/tests/flaky-tests.md)
- [Currents: Test Orchestration](https://docs.currents.dev/guides/test-orchestration.md)
- [Currents: Playwright sharding](https://docs.currents.dev/guides/parallelization-guide/playwright-sharding.md)
- [Trunk: Eradicating flaky tests](https://trunk.io/blog/eradicating-flaky-tests)
- [Trunk: Ticketing（CODEOWNERS）](https://docs.trunk.io/flaky-tests/management/ticketing)
- [Datadog: Flaky Tests Management（状態とポリシー）](https://docs.datadoghq.com/tests/flaky_management.md)
- [Buildkite: Test state and quarantine](https://buildkite.com/docs/pipelines/configure/tests/test-suites/test-state-and-quarantine)

### 大企業の運用

- [Google: Flaky Tests at Google and How We Mitigate Them（2016）](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)
- [Google: Where do our flaky tests come from?（2017）](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html)
- [Uber: Flaky Tests Overhaul at Uber（2024）](https://www.uber.com/us/en/blog/flaky-tests-overhaul/) / 二次: [engineering.fyi](https://www.engineering.fyi/article/flaky-tests-overhaul-at-uber)
- [Slack: Handling Flaky Tests at Scale（2022）](https://slack.engineering/handling-flaky-tests-at-scale-auto-detection-suppression/)
- [Microsoft VS Code: Dealing with Test Flakiness](https://github.com/microsoft/vscode/wiki/Dealing-with-Test-Flakiness)
- [Microsoft Aspire: Quarantined Tests](https://github.com/microsoft/aspire/blob/main/docs/quarantined-tests.md)
- [Microsoft: Manage flaky tests（Azure Pipelines）](https://learn.microsoft.com/en-us/azure/devops/pipelines/test/flaky-test-management?view=azure-devops)

### リポジトリ内

- `tools/deploy/cloudflare.config.ts` / `tools/deploy/modes.ts` / `tools/deploy/deploy.sh`
- `docs/engineering.md` §配備、`docs/decisions.md` D063 / D064 / D065、`docs/testing.md`
- `work/issues/0043-product-e2e.md`、0145 / 0146 / 0159 の Result
- `packages/server/test/integration/session-do.test.ts`（cf dev の spawn / readiness / stop）
- `packages/server/test/integration/gateway/harness.ts`（テスト専用 Worker + D1 migration + seed）
- `packages/server/src/edge/handler.ts`（`/graphql` は GET 405、`/ws` は未認証 401）

## 12. 確認済 / 推測 / 未確認の一覧

### 確認済

- `cf dev` は framework があれば委譲し、`--mode` 以外を拒否する（`vite` を devDependency に置くと `npx vite` が検出され、`--port` が拒否されることを実測で確認）。Wrangler 委譲なら追加引数（`--port`）を渡す。
- `--persist-to` は `cf dev` で明示エラー。`--local` も dev では非対応。
- dev の state は `<project>/.wrangler/state/v3`。XDG はログ・registry。
- `cf dev` の cold start は 2.0〜2.2 秒、複数インスタンス可、Vite 8.3.6 の ready は 200〜250 ms。
- 製品 edge は `/graphql` GET 405、`/ws` 未認証 401。製品に `/health` は無い。
- Playwright の CI 推奨は `workers: 1`、trace は `on-first-retry`、video は既定 off。
- D1 はデータベース単位で単一スレッド。DO は 1 インスタンス直列。
- 各社の flaky 状態モデル・quarantine の考え方（Cypress / Currents / Trunk / Datadog / Buildkite）。
- Google / Slack / Microsoft の公表数値と運用。

### 推測

- browser 起動 0.3〜0.5 s、context 数 ms、seed 10〜50 ms。
- 4 shard の固定費 15 s 程度。
- `createTestHarness` の起動が数百 ms。
- Playwright の E2E が unit より flaky になりやすい（Google の large=14% からの類推）。

### 未確認（0043 で確認する）

1. **ローカルの service binding**: 別 `cf dev` の Worker を GATEWAY binding で解決できるか。Phase 1 は通らない経路にする。
2. **`createTestHarness()` が `cloudflare.config.ts`（cf）プロジェクトを読めるか**。読めない場合の代替（wrangler 設定の生成 / HTTP fake）。
3. **Playwright の CDP 仮想 authenticator で hns の passkey 登録が通るか**（`WebAuthn.enable` / `addVirtualAuthenticator`、RP ID `localhost`）。手順は 0043 の Phase 1 で実証する。
4. **`cf dev` の再起動で D1/DO がどこまで戻るか**（0146 / 0156 で一部確認済みだが、E2E の run 単位では未確認）。
5. **trace のオーバーヘッドの実測**（この環境に browser が無い）。CI の runner で 1 ジャーニーを trace on/off で測る。
6. **Vite dev の初回 transform が実際の hns の画面で何 ms か**（今回測ったのは main.tsx / App.tsx の 7〜8 ms で、画面全体ではない）。





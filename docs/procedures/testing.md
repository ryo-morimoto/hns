# テスト

2026-11-10 / D056・D057。`npm run check` の一部。テストの分析・設計・コードの管理を1箇所に固定する。
設計の判断は [design.md](../design.md)、レビューは [review.md](review.md)、記録は [decisions.md](../decisions.md) と work/ に置く。

## 原則

1. **何を証明するかを先に決める。** 受入条件をそのままテストにしない。
2. 条件をリスクで並べ、**低い層で証明できるものから**設計する。
3. テストはコードの隣に置く。**仕様は TSDoc の契約、証明はテスト**。
4. **中央カタログと docs の検証表は作らない。** 要求 → docs → TSDoc → テストの順で辿る。
5. 失敗するテストを先に書く。何が壊れたら落ちるかを言えないテストは足さない。

## 1. テスト分析（何をテストするか）

### テストベース

- issue の Goal / 受入条件
- [workspace.md](../workspace.md) / [auth.md](auth.md) / [durability.md](../durability.md) / [safety.md](safety.md) / [observability.md](../observability.md) / [automation.md](automation.md)
- 契約（型・valibot schema・HTTP / GraphQL の形）
- リスク、[findings](../../work/findings/README.md)、過去のレビュー

### Example Mapping

issue の受入条件を、そのままテストにしない。次の4つに分ける。

- **Story**: issue の Goal
- **Rules**: 受入条件を「〜のとき、〜する」に直したもの
- **Examples**: 具体的な Given / When / Then
- **Questions**: 決められないこと → issue の `## 未確定`

### テスト条件

issue の `## テスト条件` に書く。

```md
| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | a.txt が v1、別の書き込みで v2 → v1 で書く → conflict、内容は v2 | 高 | docs/workspace.md#version |
```

- リスクは **高 / 中 / 低**。高は失敗系・境界・並行を最低1つ持つ。
- 非機能は ISO 25010 の品質特性（機能適合性、性能効率性、信頼性、セキュリティ、保守性）で抜けを確認する。
- **テストしない条件は理由を書く。** 空欄にしない。

## 2. テスト設計（どう証明するか）

issue の `## テスト設計` に書く。

```md
| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 状態遷移 | integration | src/version.test.ts "a stale version conflicts" |
```

### 技法

| 条件の形 | 使う技法 |
| --- | --- |
| 入力範囲・境界 | 同値分割 + 境界値分析 |
| 条件の組合せ | デシジョンテーブル / ペアワイズ |
| 状態・遷移 | 状態遷移テスト |
| 業務シナリオ | ユースケース / シナリオテスト |
| 故障・並行・再送 | 故障注入 / 競合テスト |
| 外部インターフェース | 契約テスト |
| 重要ロジックの網羅 | ブランチカバレッジ（必要な箇所だけ） |

### 層

| 層 | 何を証明するか | 実行 | 置き場所 |
| --- | --- | --- | --- |
| static | 型・lint・schema の整合 | tsc / oxlint / tsrs | — |
| unit | ロジック・schema・遷移 | 単一プロセス | `packages/<pkg>/src/**/*.test.ts` または in-source |
| contract | wire / schema の往復 | 単一プロセス | `packages/core/src/**/*.test.ts` |
| integration | DB・process・daemon・sandbox | 実 SQLite / temp dir | `packages/<pkg>/test/integration/` |
| component | UI の状態・操作 | jsdom | `packages/web/src/**/*.test.tsx` |
| E2E | 主要ユーザージャーニー | 実ブラウザ + 実サーバ | `e2e/` |
| manual | 未知のリスク・UX | 人 | — |

- **unit が既定。** 1プロセスで終わらないものだけ integration に上げる。「遅い」は層の理由にしない。
- **同じシナリオを複数の層で回さない。** シナリオは一度だけ、最も低い層で実行する。
- store の DB テストは miniflare の実 D1 SQLite（workerd）を使う。workerd は子プロセスなので integration 層に置く（D064）。
- サーバ実装後は、Workers の runtime テストを integration に置く。

### Workerd の上で確かめること（0274n）

**store の DB テストは miniflare の D1 を Node から呼んでいる。** `harness.ts` の `db` は miniflare の D1 クライアントで、`e2e/support/d1.ts` の `node:sqlite` はその代役。**Worker の中で binding がどう振る舞うかは、この2つでは分からない。** `blockConcurrencyWhile`・isolate の再利用・`sql.batch` のような「実行環境だけが決める」前提を確かめるときは、**そのコードを Worker にバンドルして miniflare に走らせる**（`packages/server/test/integration/d1-batch.test.ts`：`openStore`・`bind` した `prepare`・3文の `db.batch` が、リクエストの中で返ることを固定する）。

- **本番と同じ形**は `cf dev` と、**D1 binding を持つ Worker**での実測。Node のクライアントと Worker の binding を並べるのは `packages/store/test/integration/d1-client-batch.test.ts`。
- **D1 を持たない代役（`node:sqlite` など）の上で観測した hang を、D1 の欠陥と読まない。** 0239 の workerd の `sql.batch` の hang はこの形の報告で、**実 D1 では Worker の中でも起きない**（上のテストが固定する）。
- **代役と D1 の違いは、測ったものだけを書く。** `e2e/support/d1.ts` を読むと **① `batch` は逐次の `run()` で、SELECT / DDL の行を返さない ② 途中で失敗しても戻らない（原子的でない）** が違いで、D1 については **`packages/server/test/integration/d1-batch.test.ts` が、`batch` が 1 トランザクションであること（途中で失敗すると全部戻る）と `RETURNING` の行が返ることを固定している**。**それ以外の差分（`RETURNING` を含む文の結果の形など）は実測していない。**
- **覆っていない条件は Result と test の remark に書く。** 0274n で覆えていないのは、**`blockConcurrencyWhile` の中**・**同じ isolate の 2 回目以降と並行 dispatch**・**`cf dev` の常設 integration（実測はしたが、そのプロジェクトは repo に無く再現手順も無い＝未記録）** の3つ。

### E2E のブラウザ / 端末

E2E の既定は 3 構成（D101）。

| project | engine | 設定 | PR | nightly |
| --- | --- | --- | --- | --- |
| `chromium` | Chromium | Desktop Chrome（1280×720） | 全スモーク | 全ジャーニー |
| `firefox` | Firefox | Desktop Firefox（1280×720） | 全スモーク | 全ジャーニー |
| `firefox-mobile` | Firefox | 390×844 / DPR 3 / isMobile / hasTouch | 全スモーク | 全ジャーニー |

- 全ジャーニー × 全ブラウザを PR で回さない。PR は `@smoke`、nightly は全部を 3 構成で回す。PRF のテストは PR では Chromium の 1 回だけ。nightly も Chromium のみ。
- 認証は `context.credentials`（cross-browser）。PRF だけ CDP の Chromium に限定し、`@chromium-cdp` とテスト内の `test.skip` を併用する。PRF なしは Firefox / mobile Firefox の PR と Chromium の nightly で、セッション成立 + secret locked（423）を確認する。
- `firefox-mobile` は Playwright の device descriptor ではない。Firefox の viewport / `isMobile` / `hasTouch` の emulation で、実機の Firefox Android ではない。実機確認の置き場は未確定（0113 / 0114 のどちらか。現時点では未検証）。
- Safari / WebKit / 実機 iOS・Android は E2E の対象外。Playwright WebKit を Safari と呼べない。Safari / iOS Safari / 実機 Android の手動確認は 0113 / 0114 のどちらに置くか未確定（現時点では未検証）。
- ブラウザ差は E2E で見る。unit / component をブラウザごとに回さない。この節の project 行列を正とし、0043 などの写しと食い違ったらこの節を直す。

### E2E の主張の範囲

**E2E は体験を見る。配線の順序は integration と component が見る。** E2E の主張は「利用者が開いて読める／
失敗が画面で説明される」までで、**どの層がどの object を引くか、どのタイマーがいつ張られるか**は主張しない。
配線の退行は、その層の integration（実 Durable Object・実 DB・実 machine の境界）と component（実ビルドの
UI と実 query/mutation の文書）で、**E2E を回さずに**検出できるようにする。

理由: E2E は環境（ブラウザ・実 pack・machine・ホストのライブラリ）に強く依存し、**環境が揃わなければ
落ちる**。配線の証明をそこに置くと、環境の障害が製品の退行として現れ、逆に環境が緩いと退行が隠れる。
0239 では、object 名の解決と配信路の分離を `office-alarm.test.ts`（integration）が、プレビューの
ポーリングを `DocumentPanel.test.tsx`（component、実ビルドの文書）が受け持ち、E2E は 3 形式の表示・
キャッシュ・監査・キーボード・拒否を見る。

**E2E の実行手順と環境の前提は `e2e/README.md` に置く**（ブラウザ、pack、`LD_LIBRARY_PATH`、`PLAYWRIGHT_BROWSERS_PATH`）。
実 pack・machine・ホストのライブラリを要る journey は **`npm run check` に入れない**（CI への持ち込みは CI 基盤の issue）。

### ケースとレビュー

- ケースは「前提 / 操作 / 期待 / 事後」で書く。期待結果が言えない条件は設計に戻す。
- 高リスクは「正常1 + 失敗1 + 境界1」を最低線にする。
- 設計レビューをコード前に1回。実装後は、設計表とテストコードが一致しているかをレビューする。

## 3. テストコード（証明）

### 置き場所

```text
packages/<pkg>/src/<module>.test.ts      # コロケートした unit
packages/<pkg>/src/<module>.ts           # 小さな純粋関数は if (import.meta.vitest)
packages/<pkg>/test/integration/         # DB・process・daemon・sandbox
packages/<pkg>/test/support/             # fixture / builder。ビルドから除外
e2e/                                      # Playwright。pages / fixtures / journeys。projects は chromium / firefox / firefox-mobile
```

- 共有 fixture パッケージは作らない。2パッケージ以上で重複が証明できたときだけ検討する。
- unit テストは `src/**/*.test.ts(x)` に置く。integration は `test/integration/`、共有 fixture は `test/support/`。

### アサーション

- **通常のアサーションは Vitest の `expect` を使う。** `node:assert` も使ってよい（D062）。どちらか一方に統一しない。
- 等値はプリミティブなら `toBe`、オブジェクトなら `toStrictEqual`。`node:assert` の `equal` / `deepEqual` も可。
- 型の絞り込みが要る箇所は `node:assert` の `assert` / `assert.ok` / `assert.equal`、または `expect.assert(...)` を使う（matcher は型を絞らない）。`as` を増やさない。
- テストも `tsrs --noEmit` の対象。`any`・`@ts-ignore`・根拠のない `as` は禁止。

### 書き方

1. **1テスト1振る舞い。** 名前は「何が壊れたら落ちるか」。
2. `// Catches: <1行>` は回帰テストにだけ。**issue 番号は書かない。**
3. 失敗経路を必ず。不正入力、違法遷移、conflict、未知 enum、拒否パス。
4. `sleep` で同期しない。観測可能な条件を待つ。WS は終端イベントまで読む。
5. テストごとに temp dir / DB。共有状態を持たない。port を開かない。
6. テストを足さない変更は「何を証明したか」を説明する。
7. 非自明なテストは、直す前のコードで落ちることを確認する。

### テストダブル・永続化・skip・flaky

- **永続化**: テスト対象に schema・constraint・migration・SQL が含まれるなら実 SQLite。呼び出し側のロジックだけなら fake でよい。
- **テストダブル**: 外部・遅い・非決定的・入手不能な依存だけ double にする。テスト対象は mock しない。interaction mock より fake / stub を優先。
- **skip**: 依存を用意できない環境では skip し、理由と「どこでその経路を検証するか」を書く。
- **flaky**: 欠陥として直す。retry で隠さない。CI の retry は診断用に限り、quarantine とセットにする。
- ネットワークに出ない。モデルは faux、時計・ID は注入する。

### TSDoc 契約

- 範囲: **export する API + 内部の重要な関数**（不変条件、並行・再送、認可、migration、状態遷移）。
- `@remarks` に不変条件、`@throws` に失敗、`@example` に実行可能な例を書く。内部関数は `@internal` を付ける。
- 型で表せることは型にする。コメントで型を説明しない。
- インラインコメントは **why** だけ。what の再説明はしない。
- `@example` は [vite-plugin-doctest](https://github.com/ssssota/doc-vitest) で実行する。コードフェンスは ` ```ts @import.meta.vitest `。
- doctest の制約: static import 不可（dynamic import を使う）、lifecycle hook 不可、型検査不可。複雑なセットアップが要るものはコロケートテストに置く。
- 本番ビルドに doctest / in-source のコードを残さない。core / store / workspace / agent のビルドは tsdown（Rolldown）で、`import.meta.vitest` を `undefined` に置換して落とす。`tools/gate/dist-check.ts` が dist の JS に `import.meta.vitest` や `test()` / `expect()` が残っていないかを検査し、ビルドを落とす。
- in-source テストを書くファイルがあるパッケージは、`tsconfig.json` の `types` に `vitest/importMeta` を入れる。

### トレーサビリティ

- **中央カタログも docs の検証表も作らない。**
- 要求 → docs（why / ドメイン規則）→ TSDoc（契約）→ テスト（証明）の順で辿る。
- 横断表示が必要なら TypeDoc の API ドキュメントとテストレポートを生成する。手で維持する表は作らない。
- `npm run docs:api` が `docs/api/` に API ドキュメントを生成する（ゲート外。生成物はコミットしない）。公開 signature が `@internal` の型を参照する箇所は TypeDoc が warning を出す。0 errors を条件にし、この warning は許容する。
- issue 番号はテスト・コード・TODO に書かない。issue 側からパスを参照する。

## 4. ゲート

- `npm run check` = 全パッケージに oxlint → oxfmt → tsrs → `vitest run`（integration 含む）→ build → knip。
- コミット時は `npm run gate` が、ステージ済みのパスから選んだパッケージに lint → fmt → typecheck → **unit テスト**を回す。
- push 時は `npm run gate pre-push` が全パッケージに全段階（integration・build・knip を含む）を回す。定義は [tools/gate/stages.ts](../../tools/gate/stages.ts)、選別は [tools/gate/select.ts](../../tools/gate/select.ts)。
- CI も同じコマンド。テストのためだけの別ランナー・別設定を作らない。
- E2E は `npm run check` に入れない。`npm run test:e2e` で 3 構成を回し、CI は 0041 の後に別ジョブ（PR はスモーク × 3 構成、nightly は全部 × 3 構成）にする（0043 / D101）。
- **mutation probe（実装を壊してテストが落ちるか）はリポジトリのルートから `npx vitest run --project <name> <path>` で回す**。
  パッケージのディレクトリで `npx vitest run <path>` を叩くと、ルートの `vitest.config.ts` の alias（`@hns/*` → `src`）が
  効かず `dist` に解決されるため、**壊した実装が素通りして「検出」と誤判定する**（0271n のレビューで実際に起きた）。

## 移行（2026-11-10）

| issue | 内容 | 状態 |
| --- | --- | --- |
| 0183 | 方針・tsdown / doctest のスパイク | done |
| 0185 | tiers の二重実行を廃止 | done |
| 0184 | アサーション方針（expect + assert） | done |
| 0186 | コロケーションと issue 参照の削除 | done |
| 0187 | TSDoc 契約と doctest の全パッケージ展開 | done |

unit テストは各パッケージの `src` にコロケートされ、doctest と in-source テストは core / store / workspace / agent の4パッケージで動いている。

## 参考

- [ISTQB CTFL: Test Process, Testware, and Traceability](https://open-exam-prep.com/study-guides/istqb-foundation/fundamentals-of-testing/test-process-testware-traceability)
- [Cucumber: Example Mapping](https://cucumber.io/docs/bdd/example-mapping/)
- [Martin Fowler: Given When Then](https://martinfowler.com/bliki/GivenWhenThen.html)
- [Google Testing Blog: Test Sizes](https://testing.googleblog.com/2010/12/test-sizes.html)
- [Google Testing Blog: Just Say No to More End-to-End Tests](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)
- [Software Engineering at Google, Ch.11 Testing](https://abseil.io/resources/swe-book/html/ch11.html)
- [Vitest: In-Source Testing](https://vitest.dev/guide/in-source.html)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)

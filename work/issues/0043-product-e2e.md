# 0043: 製品の E2E テスト

status: open
priority: next
design: agreed
design-ref: D099, D101
depends-on: 0102, 0145, 0146, 0159, 0178
touches: e2e/, docs/testing.md, package.json, package-lock.json, .github

## Goal

主要なユーザージャーニーを、実ブラウザ + 実サーバで検証する。ツールは Playwright、テスト名をジャーニー名にする。
E2E は単体・結合・契約で代替できないものだけに絞る。ブラウザは Chromium / Firefox / mobile Firefox の 3 構成にする。

## Acceptance criteria

### Phase 1: ハーネスとスモーク

- [ ] Playwright を exact pin する（Credentials に 1.61 以上が必要。現在の最新安定は 1.65.1）。e2e/ に harness（pages / fixtures / journeys）を置く
- [ ] ローカルの Workers ランタイム + 実 D1/DO + Vite UI を起動する
- [ ] passkey は context.credentials（cross-browser）で登録・ログインする。PRF だけ CDP の Chromium に限定する
- [ ] 3 本のスモーク（ログイン、会話の送信、ファイル編集）を chromium / firefox / firefox-mobile で通す。ファイル保存は 0157 の後、それまでは editor を開く
- [ ] 失敗時に project 名つきの trace / screenshot / サーバログを保存する。video は無い
- [ ] npm run test:e2e を追加し、3 構成を回せる。npm run check には入れない
- [ ] CI の別ジョブで動かす（0041 の後。それまでは npm run test:e2e）

### Phase 2: 主要ジャーニー

- [ ] 会話のストリーミングと中断
- [ ] 会話の一覧・改名・削除
- [ ] 古い版の書き込みで競合表示
- [ ] Workflow 実行と human 入力
- [ ] Automation トリガー → 実行
- [ ] 複数マシンの状態表示
- [ ] WS 切断 → 再接続
- [ ] 未認証・越権アクセスの拒否
- [ ] 各ジャーニーを 3 構成で回す（PR は @smoke、nightly は全部）

## Notes

- テスト名はユーザーに見える振る舞いで書く（Gherkin は使わない）。
- 外部 provider だけ faux。内部境界はモックしない。
- 各テストは一意の workspace / user を作り、API で seed する。UI でセットアップしない。
- sleep を使わず、WS の終端イベント / web-first assertion で待つ。
- PR はスモーク 3 本 × 3 構成、main / nightly で全部 × 3 構成。retry は診断用に限り、flake は quarantine。
- 複数オリジン・複数タブ・trace が必要なので Playwright を選ぶ。
- Phase 1 は 0102 / 0145 / 0146 / 0159 / 0178 を待つ。Phase 2 の Workflow / Automation は 0038、複数マシンは 0147 / 0148、認証の再編は 0158 を待つ。
- CI の別ジョブは 0041 の後。それまでは `npm run test:e2e` をローカルと手動で回す。
- browser は Playwright 管理の Chromium / Firefox を使う。`npx playwright install chromium firefox` を dev / CI の setup に入れ、システムの Firefox は使わない。CI は Playwright の version を key に cache する。
- mobile Firefox は Playwright の device descriptor ではない。Firefox の viewport / isMobile / hasTouch で作る。実機確認の置き場は未確定（0113 / 0114 のどちらか。現時点では未検証）。

## Design（D099 / D101 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D099）。同日、ブラウザ行列を D101 で拡張した。

### 前提

- ツールは **Playwright**（user 決定）。Phase 1（ハーネス + スモーク）と Phase 2（ジャーニー）に分ける。
- **D065: CLI は `cf` に統一し、wrangler を直接実行しない**（wrangler は cf の内部 bundler だけ）。E2E の local runtime も `cf dev --mode development` を使う。
- deps: 0102 / 0145 / 0146 / 0159 / 0178 は done。**0157（content）は未実装**なので、ファイル編集のスモークは 0157 の後に有効化する。
- `npm run check` には入れない。Phase 1 は `npm run test:e2e`。CI は 0041 の後。
- ブラウザは **D101** の 3 構成。Safari / WebKit / 実機 iOS・Android / pixel diff は E2E の対象外。手動確認の置き場は未確定（0113 / 0114 のどちらか。現時点では未検証）。

### 決定 1: harness の形

- `e2e/pages/`（画面の操作）、`e2e/fixtures/`（サーバ起動・seed・passkey）、`e2e/journeys/`（ジャーニー）。
- テスト名はユーザーに見える振る舞い（Gherkin なし）。1 テスト = 1 ジャーニー。
- `e2e/support/` に待ち合わせ（WS 終端 / web-first assertion）と失敗時の artifact 収集。

### 決定 2: 実行環境（調査で確定）

- Phase 1: **`cf dev --mode development`**（D065。local D1 / DO）+ **別プロセスの Vite**。E2E 用の cf プロジェクトに Vite を同居させない（`cf dev` は Vite を検出すると `npx vite` に委譲し、`--mode` 以外の引数、`--port` も拒否する。実測）。
- 起動は `cf dev` 2.0〜2.2 秒、Vite ready 200〜250 ms（実測）。readiness は `/ws` の 401 か stdout の `Ready on` で待つ。
- **state は `<project>/.wrangler/state/v3`**。`XDG_CONFIG_HOME` はログ / registry にしか効かず、D1 / DO は分かれない（実測）。したがって **1 サーバ + テストごとの一意な `runId` / `testId`** を既定にし、完全分離が要るテストだけ一時プロジェクト + 別ポートで `cf dev` を立てる。
- `--persist-to` は `cf dev` で明示エラー、`--local` も非対応。D1 を直接 seed しない（`cf d1 --local` は dev のデータを見ない）。
- 0160 の後: ビルドした assets を Worker から配る構成でも 1 本スモークを回す。
- 外部 provider だけ faux。D1 / DO / 0159 / 0145 はモックしない。
- 1 つの `cf dev` + Vite を 3 project で共有する。browser context はテストごとに分ける。

### 決定 3: seed はテスト専用 Worker の経路（調査で確定）

- seed は **テスト専用 Worker** の `/__e2e/seed`。**製品 Worker の route は増やさない**（env-gated でも製品にテスト経路を置かない）。
- テスト用トークン（起動ごとにランダム）で保護し、user / project / conversation を DO の RPC で作る。
- 1 テスト 1 回の seed にまとめる。データは `runId` / `testId` で一意にし、cleanup はテストの最後にまとめて行う。
- `cf d1 --local` は dev のデータを見ないので、D1 直接 seed をしない。
- UI でセットアップしない。
- passkey を使うテストのために、**テスト用 user と passkey の公開鍵**を seed できるようにする。秘密鍵は受け取らない。セッションを seed で発行しない（ログインは E2E で通す）。

### 決定 4: 認証（D101 で更新）

- 全ブラウザで Playwright 1.61+ の **`context.credentials`** を使い、passkey の登録・ログインを回す。CDP は不要（Chromium / Firefox / WebKit で動く）。
- **PRF あり**は CDP の `WebAuthn.addVirtualAuthenticator`（`hasPrf: true`）を Chromium だけで使う。タグだけでは他 project から除外されないので、テスト内で `test.skip(({ browserName }) => browserName !== 'chromium', 'PRF needs CDP')` を書き、レポート用に `@chromium-cdp` を付ける。DEK の unlock、secret の read/write、再起動後の lock、復旧コードの unlock を確認する。
- **PRF なし**は Firefox / mobile Firefox の PR と Chromium の nightly（C18）で、セッションは成立するが secret は locked（423）になることを確認する。Chromium の PR ログインは PRF あり（C14）に使う。
- テストごとの一意ユーザーを保つ。fixture が `context.credentials.create(rpId)` で仮想 credential を作り、公開鍵だけを `/__e2e/seed` に登録し、`install()` してからログイン画面を操作する。秘密鍵はテストプロセスから出さない。
- RP ID は `localhost`（WebAuthn の secure context）。
- 共有 `storageState` は既定にしない。`storageState({ credentials: true })` は将来 setup project を導入するときの選択肢として残す。

### 決定 5: 待ちと flake（調査で確定）

- `sleep` を使わない。WS の終端イベント / web-first assertion で待つ。
- retry は 1。**trace は `on-first-retry`、video は off**、失敗時は **project 名つき**の trace / screenshot / サーバログ / state ダンプ。trace は action の多いテストで約 2 倍、video は 133% 遅くなる報告があるため常時は取らない。
- quarantine は **file + project + tag + owner + 14 日 SLA**。smoke は quarantine しない。nightly は `failOnFlakyTests` で検出する。retry は project 単位で扱う。

### 決定 6: CI と範囲（D101 で更新）

- Phase 1 は **workers=1**（Playwright の CI ガイドも 1 worker を推奨）。並列化は sharding で行う（D1 は DB 単位で単一スレッド、DO は単一インスタンスで直列化するため、同じ state で worker を増やすと flake になる）。
- PR は **スモーク 3 本 × 3 構成**。nightly は全部を **shard 2→4** に分け、blob + junit を `merge-reports` で統合する。
- 目標: PR smoke p50 < 90 秒、nightly < 12 分（暫定。Phase 1 の実測をこの issue に残す）。
- CI の別ジョブは 0041 の後。**3 構成を回す。Safari / WebKit / 実機 / pixel diff は E2E の対象外**。Safari / iOS Safari / 実機 Android の手動確認は 0113 / 0114 のどちらに置くか未確定（現時点では未検証）。

### 決定 7: ブラウザ行列（D101）

| project | engine | 設定 | PR | nightly |
| --- | --- | --- | --- | --- |
| `chromium` | Chromium | Desktop Chrome（1280×720） | 全スモーク | 全ジャーニー |
| `firefox` | Firefox | Desktop Firefox（1280×720） | 全スモーク | 全ジャーニー |
| `firefox-mobile` | Firefox | 390×844 / DPR 3 / isMobile / hasTouch | 全スモーク | 全ジャーニー |

- `firefox-mobile` は `devices['Desktop Firefox']` に viewport / screen / deviceScaleFactor / isMobile / hasTouch を重ねる。Playwright に mobile Firefox の descriptor は無い。
- UA は Desktop Firefox のまま。UA 分岐ではなく CSS の responsive で mobile を成立させる。
- 実機の Firefox Android の確認は未確定（0113 / 0114 のどちらか。現時点では未検証）。RDM は safe area / 仮想キーボード / UA を再現しない。
- 全ジャーニー × 全ブラウザを PR で回さない。Phase 2 でジャーニーが増えても PR は `@smoke` だけに絞る。
- ログインの内訳: Chromium は C14（PRF あり）、firefox / firefox-mobile は C12 / C13（PRF なし）。会話とファイル編集は 3 構成（T2 / T3 が chromium / firefox、T15 が firefox-mobile）。合計 3 本 × 3 構成 = 9 実行。Chromium の PRF なしは C18 で nightly に回す。
- project 行列の正は `docs/testing.md`（D101）。この表は実装用の写し。

### 決定 8: Phase の対応

- Phase 1: ログイン、会話の送信、ファイル編集（0157 の後に有効化。それまでは editor を開くところまで）。3 構成で回す。
- Phase 2: ストリーミングと中断、一覧・改名・削除、競合、Workflow / human（0038）、Automation（0161）、複数 machine（0147 / 0148）、WS 再接続、未認証・越権の拒否（0158）。PR は `@smoke`、nightly は全部を 3 構成で回す。

### 調査（完了）

- `work/research/e2e-testing.md`: `cf` の実測、Playwright のテスト管理、性能。
  - `cf dev` 2.0〜2.2 秒 / Vite ready 200〜250 ms / state は `.wrangler/state/v3`（XDG はログのみ）/ `--persist-to` 拒否 / `cf d1 --local` は dev を見ない。
  - workers=1 + shard、blob + junit、retry 1、trace on-first-retry、video off、quarantine file + project + tag + owner + 14 日 SLA（D101）。
  - 起動・seed を 1 回にし、prebuild を共有。trace / video のオーバーヘッドを避ける。
  - 未確認: local service binding、`createTestHarness()` の cf 対応、passkey の `context.credentials` 登録と PRF の CDP、trace の実測。
  - このノートの PR 60 秒 / nightly 8 分は D099 時点のもの。D101 が 90 秒 / 12 分に置き換える（履歴は書き換えない）。
- `work/research/e2e-browser-matrix.md`: Firefox / mobile Firefox の追加調査。
  - Playwright `context.credentials` は Chromium / Firefox / WebKit で動く（1.61+）。PRF は CDP の Chromium に残る。
  - Firefox の `isMobile` は 1.61.0 でサポート。mobile Firefox の descriptor は無い。
  - OSS は全テスト × 全ブラウザを避け、スモークや機能単位でクロスブラウザを回す（Cal.com / Element Call / Storybook / Next.js）。
  - PR はスモーク、nightly は全部。flake は retry で隠さず quarantine する（Gradle / GitLab / Google）。

### 決定（D099）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 実行環境 | **決定（user）**: `cf dev` + 別 Vite。1 サーバ + 一意 id、完全分離は一時プロジェクト + 別ポート | 0160 / 0145 / D065 | 2026-11-17 |
| U-02 | seed | **決定（user）**: テスト専用 Worker の `/__e2e/seed`。製品 route は増やさない。1 テスト 1 回 | 0145 / 0146 | 2026-11-17 |
| U-03 | passkey | **D101 で置換**: 全ブラウザ `context.credentials`、PRF だけ CDP の Chromium | 0108 / 0158 | 2026-11-17 |
| U-04 | ファイル編集 | 0157 の後に有効化。それまでは開くだけ | 0157 / 0125 | このレビュー |
| U-05 | CI / flake | **決定（user）**: retry 1、trace on-first-retry、video off、quarantine file + project + tag + owner + 14 日 SLA（D101 で project を追加）、smoke はしない | 0041 | 2026-11-17 |
| U-06 | テスト管理 | **決定（user）**: workers=1、nightly shard 2→4、blob + junit を merge、artifact は失敗時のみ | 0043 / 0041 | 2026-11-17 |
| U-07 | 性能 | **D101 で置換**: PR smoke p50 < 90 秒、nightly < 12 分（暫定） | 0043 | 2026-11-17 |

### 決定（D101）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-08 | ブラウザ行列 | **決定（user）**: `chromium` / `firefox` / `firefox-mobile` の 3 構成。mobile Firefox は viewport / isMobile / hasTouch の emulation | 0043 / 0113 / 0114 | 2026-11-17 |
| U-09 | 認証 | **決定（user）**: 全ブラウザ `context.credentials`。PRF だけ CDP の Chromium。PRF なしは Firefox / mobile Firefox の PR と Chromium の nightly で locked を確認 | 0108 / 0158 | 2026-11-17 |
| U-10 | PR の範囲 / 性能 | **決定（user）**: PR はスモーク 3 本 × 3 構成、nightly は全部 × 3 構成。p50 < 90 秒 / < 12 分は暫定 | 0041 / 0043 | 2026-11-17 |

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | harness 起動 → `cf dev` + Vite + seed → ログイン画面が出る | 高 | 受入1 |
| C2 | 会話を送信 → 応答が transcript に出る（faux） | 高 | 受入2 |
| C3 | ファイルを開く / 保存できる（0157 の後） | 高 | 受入2 |
| C4 | WS を切る → 再接続 → 表示が戻る | 高 | 受入3 |
| C5 | 古い版で保存 → 競合表示 | 高 | 受入3 |
| C6 | 未認証 / 越権 → 拒否。env 無しの `/__e2e/seed` → 404 | 高 | 受入4 |
| C7 | 失敗 → project 名つきの trace / screenshot / サーバログ / state ダンプ。video は無い | 中 | 受入1 / D101 |
| C8 | `npm run check` に E2E が入らない。`npm run test:e2e` が 3 構成を回し、PR は `@smoke` 3 本 × 3 構成、nightly は全部 × 3 構成 | 中 | 受入5 / D101 |
| C9 | 同じサーバで 2 テスト → 一意な runId / testId でデータが混ざらない | 高 | U-01 |
| C10 | quarantine の file + project + tag / owner / 14 日 SLA。smoke は quarantine されない | 中 | U-05 / D101 |
| C11 | 製品 Worker に `/__e2e/seed` が無い（テスト専用 Worker だけ） | 高 | U-02 |
| C12 | PRF なしの passkey で Firefox desktop にログイン → セッションは成立し、secret は locked（423） | 高 | D101 |
| C13 | 同じ条件で firefox-mobile（390×844 / touch）→ モバイルのクロームでログインでき、locked 表示になる | 高 | D101 / 0113 |
| C14 | Chromium で PRF ありの passkey → DEK が unlock し、secret の read/write ができる。再起動で locked、復旧コードで unlock | 高 | D101 |
| C15 | firefox-mobile で会話と editor のスモーク → 390×844 のモバイルシェルで操作できる（44px / hover は 0113 の a11y 確認。未検証） | 高 | D101 / 0113 |
| C16 | seed 契約 → passkey の公開鍵だけを保存し、秘密鍵を受け取らない | 高 | D101 / D099 |
| C17 | 失敗 artifact / ログに秘密鍵を出さない | 高 | D101 / D099 |
| C18 | Chromium の PRF なしログイン（nightly）→ セッションは成立し、secret は locked（423） | 中 | D101 |

### テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | ユースケース | E2E | `e2e/journeys/harness.spec.ts`（起動 + `/login` 表示） |
| T2 | C2 | ユースケース | E2E | `e2e/journeys/conversation.spec.ts`（chromium / firefox） |
| T3 | C3 | ユースケース | E2E | `e2e/journeys/editor.spec.ts`（chromium / firefox、0157 の後） |
| T4 | C4 | 状態遷移 | E2E | `e2e/journeys/live.spec.ts`（Phase 2） |
| T5 | C5 | 状態遷移 | E2E | `e2e/journeys/editor-conflict.spec.ts`（Phase 2） |
| T6 | C6 | 故障注入 | E2E | `e2e/journeys/authz.spec.ts`（Phase 2） |
| T7 | C7 | 故障注入 | E2E | 失敗させるテスト + artifact の確認 |
| T8 | C8 | デシジョンテーブル / ペアワイズ | manual | `npm run test:e2e` の project 一覧 / PR・nightly の CI ジョブ |
| T9 | C9 | 故障注入 / 競合 | E2E | 同じサーバで 2 テストを実行 |
| T10 | C10 | デシジョンテーブル | manual | quarantine ファイル / project / tag / owner / SLA のレビュー |
| T11 | C11 | 契約テスト | integration | 製品 Worker の route 表に seed が無い |
| T12 | C12 | 状態遷移 | E2E | `e2e/journeys/auth.spec.ts`（firefox only） |
| T13 | C13 | 状態遷移 + 境界値 | E2E | `e2e/journeys/auth.spec.ts`（firefox-mobile only） |
| T14 | C14 | 状態遷移 + 故障注入 | E2E | `e2e/journeys/auth-prf.spec.ts`（chromium only、@smoke、@chromium-cdp） |
| T15 | C15 | ユースケース + 境界値 | E2E | `e2e/journeys/mobile-shell.spec.ts`（firefox-mobile の会話 / editor） |
| T16 | C16 | 契約テスト | integration | seed の契約テスト |
| T17 | C17 | 故障注入 | E2E | artifact / ログの redaction 確認 |
| T18 | C18 | 状態遷移 | E2E | `e2e/journeys/auth.spec.ts`（chromium only、nightly、@nightly） |

- ブラウザ差は E2E で見る。unit / component をブラウザごとに回さない。
- T2 / T3 は chromium / firefox、T15 が firefox-mobile の会話 / editor を担当する。T15 は会話と editor の 2 本。内訳: ログイン 3（T12 / T13 / T14）+ 会話 3（T2 / T3 / T15）+ editor 3（T2 / T3 / T15）= 9 実行。
- T4〜T6 は Phase 2。T14 は Chromium のみ、T18 は Chromium かつ nightly。
- project 固有のテストは `test.skip` で絞る。T12=firefox、T13=firefox-mobile、T18=chromium（`testInfo.project.name`）。T14=chromium（`browserName`）。T18 は `@nightly` を付ける（nightly はタグで選び、project は chromium）。
- T14 は `@smoke` と `@chromium-cdp` を付け、PR の `@smoke` に含める。
- 層は `docs/testing.md` の E2E / integration / manual だけを使う。`E2E harness` / `CI` という層は作らない。
- 技法名は `docs/testing.md` の表（状態遷移 / ユースケース / 故障注入 / 契約テスト / 境界値 / デシジョンテーブル・ペアワイズ）に合わせる。

## やらないこと

- Safari / WebKit / 実機 iOS・Android の E2E。手動確認は 0113 / 0114 のどちらに置くか未確定（現時点では未検証）
- pixel diff / visual regression（0114 の範囲）
- npm run check への E2E 追加
- 全ジャーニー × 全ブラウザを PR で回すこと
- Firefox の softtoken prefs による PRF E2E（Playwright の PRF API が無い。必要になったら別 issue）

## Log

- 2026-11-10: 更新（user）。Playwright、テスト名で進める。Phase 1（ハーネス + スモーク）と Phase 2（主要ジャーニー）に分ける。
- 2026-11-17: D099 で合意。U-01〜U-07 を決定し、`design: agreed` にした。
- 2026-11-17: D101 でブラウザ行列を Firefox / mobile Firefox に拡張。D100 は 0147 で使用済みのため D101 にした。認証は `context.credentials` に更新し、PRF だけ CDP の Chromium に残した。
- 2026-11-17: 独立レビューの BLOCKED 指摘を修正。D101 が D099 の性能目標と shared storageState も置き換えることを明記し、Chromium の PRF なしを C18（nightly）に追加、C1〜C18 / T1〜T18 の設計表を揃えた。

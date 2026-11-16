# 0043: 製品の E2E テスト

status: open
priority: next
design: agreed
design-ref: D099
depends-on: 0102, 0145, 0146, 0159, 0178
touches: e2e/, docs/test/e2e.md, docs/testing.md, package.json, package-lock.json, .github

## Goal

主要なユーザージャーニーを、実ブラウザ + 実サーバで検証する。ツールは Playwright、テスト名をジャーニー名にする。
E2E は単体・結合・契約で代替できないものだけに絞る。

## Acceptance criteria

### Phase 1: ハーネスとスモーク

- [ ] Playwright を exact pin し、e2e/ に harness（pages / fixtures / journeys）を置く
- [ ] ローカルの Workers ランタイム + 実 D1/DO + Vite UI を起動する
- [ ] passkey の仮想オーセンティケータと storageState を用意する
- [ ] 3本のスモーク（ログイン、会話の送信、ファイル編集）を通す
- [ ] 失敗時に trace / video / screenshot / サーバログを保存する
- [ ] npm run test:e2e を追加し、npm run check には入れない
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

## Notes

- テスト名はユーザーに見える振る舞いで書く（Gherkin は使わない）。
- 外部 provider だけ faux。内部境界はモックしない。
- 各テストは一意の workspace / user を作り、API で seed する。UI でセットアップしない。
- sleep を使わず、WS の終端イベント / web-first assertion で待つ。
- PR はスモーク3本、main / nightly で全部。retry は診断用に限り、flake は quarantine。
- 複数オリジン・複数タブ・trace が必要なので Playwright を選ぶ。
- Phase 1 は 0102 / 0145 / 0146 / 0159 / 0178 を待つ。Phase 2 の Workflow / Automation は 0038、複数マシンは 0147 / 0148、認証の再編は 0158 を待つ。
- CI の別ジョブは 0041 の後。それまでは `npm run test:e2e` をローカルと手動で回す。

## Design（D099 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D099）。

### 前提

- ツールは **Playwright**（user 決定）。Phase 1（ハーネス + スモーク）と Phase 2（ジャーニー）に分ける。
- **D065: CLI は `cf` に統一し、wrangler を直接実行しない**（wrangler は cf の内部 bundler だけ）。E2E の local runtime も `cf dev --mode development` を使う。
- deps: 0102 / 0145 / 0146 / 0159 / 0178 は done。**0157（content）は未実装**なので、ファイル編集のスモークは 0157 の後に有効化する。
- `npm run check` には入れない。Phase 1 は `npm run test:e2e`。CI は 0041 の後。

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

### 決定 3: seed はテスト専用 Worker の経路（調査で確定）

- seed は **テスト専用 Worker** の `/__e2e/seed`。**製品 Worker の route は増やさない**（env-gated でも製品にテスト経路を置かない）。
- テスト用トークン（起動ごとにランダム）で保護し、user / project / conversation を DO の RPC で作る。
- 1 テスト 1 回の seed にまとめる。データは `runId` / `testId` で一意にし、cleanup はテストの最後にまとめて行う。
- `cf d1 --local` は dev のデータを見ないので、D1 直接 seed をしない。
- UI でセットアップしない。

### 決定 4: 認証

- Playwright の CDP で **仮想 authenticator** を作り、seed した passkey を登録する。
- `storageState` をユーザーごとに保存し、ログインの繰り返しを避ける。RP ID は `localhost`（WebAuthn の secure context）。
- storageState は artifact に含めるが、秘密（provider 鍵など）は入れない。

### 決定 5: 待ちと flake（調査で確定）

- `sleep` を使わない。WS の終端イベント / web-first assertion で待つ。
- retry は 1。**trace は `on-first-retry`、video は off**、失敗時は screenshot + サーバログ + state ダンプ。trace は action の多いテストで約 2 倍、video は 133% 遅くなる報告があるため常時は取らない。
- quarantine は **ファイル + タグ + owner + 14 日 SLA**。smoke は quarantine しない。nightly は `failOnFlakyTests` で検出する。

### 決定 6: CI と範囲（調査で確定）

- Phase 1 は **workers=1**（Playwright の CI ガイドも 1 worker を推奨）。並列化は sharding で行う（D1 は DB 単位で単一スレッド、DO は単一インスタンスで直列化するため、同じ state で worker を増やすと flake になる）。
- PR はスモーク 3 本。nightly は全部を **shard 2→4** に分け、blob + junit を `merge-reports` で統合する。
- 目標: PR smoke p50 < 60 秒、nightly < 8 分。
- CI の別ジョブは 0041 の後。Chromium のみ。mobile / cross-browser / pixel diff はやらない（0113 / 0114 の範囲）。

### 決定 7: Phase の対応

- Phase 1: ログイン、会話の送信、ファイル編集（0157 の後に有効化。それまでは editor を開くところまで）。
- Phase 2: ストリーミングと中断、一覧・改名・削除、競合、Workflow / human（0038）、Automation（0161）、複数 machine（0147 / 0148）、WS 再接続、未認証・越権の拒否（0158）。

### 調査（完了、`work/research/e2e-testing.md`）

- `cf` の実測: `cf dev` 2.0〜2.2 秒 / Vite ready 200〜250 ms / state は `.wrangler/state/v3`（XDG はログのみ）/ `--persist-to` 拒否 / `cf d1 --local` は dev を見ない。
- テスト管理: Playwright workers=1 + shard、blob + junit、retry 1、trace on-first-retry、video off、quarantine ファイル + owner + 14 日 SLA。
- 性能: 起動・seed を 1 回にし、prebuild を共有。trace / video のオーバーヘッドを避ける。
- 未確認: local service binding、`createTestHarness()` の cf 対応、passkey の CDP 登録、trace の実測。

### 決定（D099）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 実行環境 | **決定（user）**: `cf dev` + 別 Vite。1 サーバ + 一意 id、完全分離は一時プロジェクト + 別ポート | 0160 / 0145 / D065 | 2026-11-17 |
| U-02 | seed | **決定（user）**: テスト専用 Worker の `/__e2e/seed`。製品 route は増やさない。1 テスト 1 回 | 0145 / 0146 | 2026-11-17 |
| U-03 | passkey | CDP 仮想 authenticator + storageState | 0108 / 0158 | このレビュー |
| U-04 | ファイル編集 | 0157 の後に有効化。それまでは開くだけ | 0157 / 0125 | このレビュー |
| U-05 | CI / flake | **決定（user）**: retry 1、trace on-first-retry、video off、quarantine ファイル + tag + owner + 14 日 SLA、smoke はしない | 0041 | 2026-11-17 |
| U-06 | テスト管理 | **決定（user）**: workers=1、nightly shard 2→4、blob + junit を merge、artifact は失敗時のみ | 0043 / 0041 | 2026-11-17 |
| U-07 | 性能 | **決定（user）**: 起動 1 回・seed 1 回・prebuild 共有。PR smoke p50 < 60 秒、nightly < 8 分 | 0043 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | harness 起動 → `cf dev` + Vite + seed → ログインできる | 高 | 受入1 |
| C2 | 会話を送信 → 応答が transcript に出る（faux） | 高 | 受入2 |
| C3 | ファイルを開く / 保存できる（0157 の後） | 高 | 受入2 |
| C4 | WS を切る → 再接続 → 表示が戻る | 高 | 受入3 |
| C5 | 古い版で保存 → 競合表示 | 高 | 受入3 |
| C9 | 同じサーバで 2 テスト → 一意な runId / testId でデータが混ざらない | 高 | U-01 |
| C10 | quarantine のタグ / owner / 14 日 SLA。smoke は quarantine されない | 中 | U-05 |
| C11 | 失敗時だけ trace / screenshot / log。video は無い | 中 | U-05・U-07 |
| C12 | 製品 Worker に `/__e2e/seed` が無い（テスト専用 Worker だけ） | 高 | U-02 |
| C6 | 未認証 / 越権 → 拒否。env 無しの `/__e2e/seed` → 404 | 高 | 受入4 |
| C7 | 失敗 → trace / video / screenshot / log が残る | 中 | 受入1 |
| C8 | `npm run check` に E2E が入らない。`npm run test:e2e` で動く | 中 | 受入5 |

## Log

- 2026-11-17: D099 で合意。U-01〜U-07 を決定し、`design: agreed` にした。

## やらないこと

- mobile / cross-browser（最初は Chromium だけ）
- pixel diff / visual regression（0114 の範囲）
- npm run check への E2E 追加

## Log

- 2026-11-10: 更新（user）。Playwright、テスト名で進める。Phase 1（ハーネス + スモーク）と Phase 2（主要ジャーニー）に分ける。

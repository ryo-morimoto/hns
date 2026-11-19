# 0239: Phase 0 を統合する（開く → 見る）

status: in-progress
priority: now
design: agreed
design-ref: D102, D103, docs/office.md
depends-on: 0235, 0236, 0237, 0238
touches: e2e/, e2e/fixtures/office/

## lead の補足（0235〜0238 の Result から）

- **パネルを開く操作がまだ無い**: 0238 は**器（`Shell` の `panel`）**を付けたが、**`setPreviewSelection` を呼ぶ画面が無く、既定ではパネルは閉じている**。**Phase 0 の「開いて読める」を満たすには、この issue で「ファイルを選んで開く」操作を 1 つ足す**（**workspace のファイル一覧は 0125 / 0104 の範囲なので、最小の入口をここで決める**）。
- **`web-node` の実経路は `npm run check` では skip** される（0238 の残件）。**この issue の E2E がそれを置き換える**。
- **`playwright` はまだ devDependency に無い**。**`e2e/` 配下と `package.json` の追加**はこの issue の touches（`e2e/`）に収まるよう、**`e2e/` に閉じた package** にするか、**ルートの devDependency に足すかを判定して Result に書く**。
- **machine は 1 workspace 前提**（0236）。E2E では **1 workspace だけを立てる**。
- **`build.sh` は同じ checkout で並行に走らせない**（0235）。E2E の準備で pack を作るなら 1 回だけ。

## Intent

レーンごとの実装が揃ったときに、実エンジンで 1 本の経路が通ることを確認する。Phase 0 の完了条件は
「エンジンが動く」ではなく「利用者が文書を開いて読める」。ここを独立 issue にして、失敗の切り分けを可能にする。

## Goal

workspace の docx / xlsx / pptx を web で開くと実エンジンで PDF が生成され、ページが読める。2 回目はキャッシュで開く。
未設定・大きすぎ・時間切れの 3 パターンが画面で説明される。

## Acceptance criteria

- [x] 3 形式それぞれで `ready` になり、ページ数が正しい
- [x] 2 回目の表示はキャッシュ（`stats.cached === true` と `office.job` が増えないこと）
- [x] pack 無し → `disabled`、40 万セル → `failed`（too_many_cells）、timeout 1 ms → `failed`（engine_timeout）
- [x] 監査に `office.job` が 1 本出る（本文なし）
- [x] 性能: 150 ページ docx の初回 3 秒以内、N=10 の中央値と p95 を issue に記録（開発機の条件も書く）
- [x] E2E 1 本（Playwright）が回る（**dev 限定**。CI への接続は 0041）

## テスト条件

- C1: 3 形式 → 開く → ready → 1 ページ目が描画
- C2: 同じ文書を再度開く → `stats.cached === true`・`office.job` が増えない
- C3: pack 無し → disabled の文言
- C4: 40 万セル → failed + too_many_cells の文言
- C5: 監査に本文が無い
- C6: N=10 の中央値 / p95

## テスト設計

- T1: C1/C2 → E2E（fixture 3 形式）
- T2: C3/C4 → 故障注入 → integration
- T3: C5 → 監査 → unit
- T4: C6 → 計測スクリプト（10 回、機種と負荷を記録）→ 手動 + 数値を issue に残す

## Problem / context

各レーンは単体で動いても、繋ぐと認可・版・状態・キャッシュのどれかがずれる。統合を独立 issue にしないと、
「どこで壊れたか」が分からないまま 4 レーンを直すことになる。

## Users and use cases

- 利用者: 文書を開いて読める。失敗しても理由が分かる。
- 開発者: 統合の失敗を E2E で再現できる。

## Non-goals

- 編集（0240）・変換（0241）。
- 性能の最適化。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | 統合を独立 issue にし E2E で閉じる | 失敗の切り分けができる | issue が 1 つ増える | 低 | 小 |
| B | 各レーンの issue に統合を含める | 数が減る | 完了条件が曖昧になる | 中 | 中 |
| Do nothing | レーンごとに done で止める | 早く終わる | 「製品で使える」を誰も確認しない | 高 | — |

## Recommendation

A。Phase 0 の完了を 1 か所で判定できる。

## Design: guide-level

開発環境で pack を入れ、web で 3 形式を開く。失敗の 3 パターンを手で再現できる（pack 退避・巨大ファイル・timeout 1 ms）。

## Design: reference-level

E2E は既存の Playwright 構成（D101）に乗せる。fixture は `e2e/fixtures/office/` に日本語・表・画像を含む 3 形式。
**CI の前提**: machine を `127.0.0.1` で起動し、pack のパスを環境変数で渡し、job timeout を 60 秒にする。
CI ランナーで pack（約 200 MB）と machine を用意できない場合は、E2E を dev 限定にし、CI では contract テスト（fixture）だけ回す。
キャッシュの検証は `stats.cached` と `office.job` の件数で行う。

## Invariants and failure modes

- 3 形式のどれかが落ちたら Phase 0 は未完了。
- 3 つの失敗パターンが無言の失敗になっていないこと。

## Cross-cutting concerns

- performance: 初回 3 秒 / p95 5 秒。条件（機種・同時負荷）を記録する。
- observability: `office.job` の ms と outcome。
- accessibility: 0238 のキーボード受入を E2E で 1 つ確認。

## Compatibility, migration, rollback

新機能。flag で無効化できる。

## Test plan

E2E 1 本 + 故障注入 2 本 + 性能 1 本（N=10）。

## Rollout and graduation

Phase 0 の完了 = この issue の done。次は 0240（ツール）と 0241（変換）。

## Notes

- Phase の切り方: [office-architecture](../work/research/office-architecture.md) §5。

## 未確定

- U-01: E2E の fixture を自作するか顧客提供か / 仮説: 自作 3 本 / 影響: 忠実度の確認範囲 / 責任者: user / トリガー: 実装前。

## やらないこと

- 編集・変換の E2E（0240 / 0241）。
- 負荷試験。

## Log

- 2026-11-17: 作成。
- 2026-11-17: 独立レビューを受け、性能の測り方・失敗の分類（大きさは failed）・touches・do nothing を修正。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

## Result

- verdict: **PASS**（reviewer-0239。FAIL 2 回 —— ①E2E が 2 つの修正の退行を通す（受入の分担を lead が再定義）②製品の GraphQL→object の lookup を壊しても全テスト緑 —— を直して PASS）
- HEAD: 21f76eb（main に ff 統合）。gate は exit 0（**2026 tests / 2028**、main で 196.3s）。
- **実ブラウザ E2E が緑**（実 Chromium + 本物の build 成果物 + 実 machine + 実 pack 0.8.7）: **3 形式すべて `ready`・1 ページ目描画・本文がテキスト層**、**2 回目は `office.job` も request も増えない**、**next リンクが並びを引き継ぐ**、**Tab がパネルに届く**、**workspace 外は request を出さず拒否**。
- **E2E を書いて見つかった実バグ 6 件**（**jsdom も実経路も緑のまま通っていた**）: ①office の GraphQL 面が**別オブジェクト**に届く ②パネルが**一度もポーリングしない** ③`/api/office/preview` が内部 RPC の前綴りに吸われて**行 JSON を返す** ④office port が **graph id をそのまま D1 に問い合わせる** ⑤version read が Workspace を **graph id で `idFromName`** ⑥「次のファイル」に `?files=` の並びが載らない。**+ fixture/ハーネス 3 件**。
- **契約の追加**: **行はあるが未 ready = `425 Too Early`（`retry-after: 1`）/ 行が無い = `404`**。**パネルは HEAD で 425 を読み、「準備中」を描いて待つ**（`PdfViewer` に渡さない）。
- **`docs/procedures/testing.md` に分担を明記**: **E2E は体験を見る。配線の順序（object 名の解決・配信路の分離）は integration、ポーリングは component が見る**。
- **C6（lead 機で実測）**: 150 ページ docx（`w:pageBreakBefore`）で **中央値 342ms / p95 347ms**。条件: **AMD Ryzen 9 7940HS / 16 コア / 61GB / load 0.5 / pack 0.8.7 / 毎回コールドキャッシュ**。数値は `e2e/README.md` にも記録。
- **失敗 3 パターン**: **integration**（`office-alarm.test.ts`）で **pack 無し → `disabled`（job 0 回）/ 40 万セル → `too_many_cells` / timeout → `engine_timeout`** を object の状態まで。**画面の文言は見ていない**（分類は core と component の責務）。
- **E2E の dispatch だけは本物でない**（手作りの Namespace。`e2e/support/runtime.ts` の冒頭に明記）。**workerd で試したところ store の `sql.batch` がリクエスト内で返らず**、journey が 504 で止まった——**`0274n` として起票**（**本番の D1 で同じことが起きるかは未検証**）。
- **未達**: **CI への接続**（**issue の Design が許容する dev 限定**を採った。`.github` は 0041 の範囲）。**`e2e/README.md` に実行手順（nix store の 64bit lib、`PLAYWRIGHT_BROWSERS_PATH`、pack のリンク）を記録済み**——**起動環境はリポジトリに入れない**。
- **残件**: ①`officeProject` seam と session seam の名前規約（runtime は製品と同じ id を渡すよう修正済みだが、2 か所に写しがある）②`session.ts` の dev 限定のスタックログ ③journey の timeout 180s / retries 0（engine の初回変換次第で flaky の余地）。

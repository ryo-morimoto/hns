# 0163: コストの上限と監視（DO 行・R2・モデル）

status: done
priority: now
design: agreed
design-ref: docs/durability.md §7, docs/limits.md
depends-on: 0151, 0153
touches: packages/server/src/cost/, deploy/limits/, packages/store/src/migrations/0003-cost.ts, packages/store/src/migrations/index.ts, packages/store/test/integration/store/store.test.ts, packages/server/src/do/state.ts, packages/server/src/do/session.ts, packages/server/src/do/session-rpc.ts, packages/server/src/do/session-rpc.test.ts, packages/server/src/do/session-cost.test.ts, packages/server/test/support/d1.ts, packages/server/test/integration/cost/, docs/limits.md, work/issues/0163-cost-and-limits.md

## Goal

課金が設計ミスで増える経路（行数・PUT 回数・トークン）を計測可能にし、上限をかける。

## Acceptance criteria

- [x] 1 ターンあたりの DO 行数・リクエスト数・R2 オブジェクト数を記録
- [x] token 単位 commit を検出するテスト（行数が閾値を超えたら失敗）
- [x] 月次の運用上限（DO / R2 / provider）とアラート
- [x] 使いすぎたときの縮退（新しい Run を止める）
- [x] 実測値を RESULTS に追記する場所を決める

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 1 ターン完了 → cost_turn に 1 行。do_rows は実行前後の DO 行数差、do_requests は 1、r2_objects は 0、outcome は completed。同じ turn id で再送 → 行は増えず、返る記録は同じ 1 行 | 高 | 受入1、D049 |
| C2 | 長い応答（200 語）の実ターンを faux で回す → 記録された do_rows が 1 ターンの閾値（24）以下。token ごとに commit する実装ならこの閾値を超える | 高 | 受入2、durability §7 の罠1 |
| C3 | 当月と前月の cost_turn がある → 当月合計を読む → 前月の行は含まれない。月が変われば同じ上限で 0 から判定する | 高 | 受入3、月次の定義 |
| C4 | 使用量が 50% 未満 → 50% を跨ぐ → warn が 1 回だけ出る。80% を跨ぐ → critical。上限以上になった → exceeded。同じ帯に留まる、または減る → 出さない | 高 | 受入3、アラート |
| C5 | DO 行の当月合計が上限以上 → messages RPC → 429 limit_exceeded、session.send は呼ばれない。同じ状態で abort / transcript / conversations は通る（既存 Run を殺さない） | 高 | 受入4 |
| C6 | provider_gateway の当月 spend が month_limit 以上 → messages RPC → 429 limit_exceeded。month_key が前月 → spend 0 として判定し、通す | 高 | 受入3・4、0151 の予算行 |
| C7 | 上限行が無い / 壊れている / D1 が失敗 → messages RPC → 503 limit_unavailable、session.send は呼ばれない（fail closed） | 高 | Fail closed |
| C8 | cost_turn の INSERT が失敗 → ターン自体は成功のまま、失敗はログだけ。同じ turn id の再送で二重計上しない | 中 | 受入1、観測の失敗 |
| C9 | 実 D1（cf dev / workerd）で migration 0003 を適用 → 当月の 2 ターンを記録 → 当月合計と上限判定が実 SQL で一致し、同じ id の再送は 1 行のまま | 中 | 受入1・3 |
| C10 | 全変更 → npm run check → exit 0 | 高 | Result |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 状態遷移（実行前後の行数）+ 冪等（同じ id） | unit（実 SQLite の D1 fake） | `src/cost/gate.test.ts` "a turn records one row with the rows it added" / "a retried turn records nothing new" |
| T2 | C2 | 境界値（閾値） | unit（実 Node SQLite + 実 Harness + faux） | `src/do/session-cost.test.ts` "one text turn stays inside the row budget" |
| T3 | C3 | 境界値（月の跨ぎ） | unit（実 SQLite） | `src/cost/ledger.test.ts` "the month total ignores the previous month" |
| T4 | C4 | 境界値（50 / 80 / 100 の前後）+ デシジョンテーブル | unit | `src/cost/alerts.test.ts` |
| T5 | C5 | 状態遷移（止める / 通す） | unit | `src/do/session-rpc.test.ts` "a used-up month refuses a new run and leaves the existing ones alone" |
| T6 | C6 | 同値分割（当月 / 前月の key）+ 状態遷移 | unit（実 SQLite） | `src/cost/gate.test.ts` "an exhausted provider month refuses a new run" |
| T7 | C7 | 故障注入（行なし・壊れ・D1 例外） | unit | `src/cost/gate.test.ts` "an unreadable gauge refuses instead of admitting" |
| T8 | C8 | 故障注入（INSERT 失敗） | unit | `src/cost/gate.test.ts` "a failed record leaves the turn successful" |
| T9 | C9 | 契約（実 D1 の SQL・制約・migration） | integration（cf dev / workerd） | `test/integration/cost/d1.test.ts` |
| T10 | C10 | ゲート | static / build | `npm run check` |

層の判断: 行数・冪等・月次 SUM・上限判定は D1 の SQL と制約が対象なので、node:sqlite の D1 fake で実 SQL を回す unit に置く（0169 の node:sqlite と同じ判断）。"実 D1 でしか出ない" もの（workerd の D1 方言、migration 0003 の適用）だけを cf dev の integration に残す。実ターンの行数は pi-durable の実 Harness と実 Node SQLite が要るので unit で回す（子プロセスは無い）。

## Design

### 計測の置き場（D049）

- **確定した記録は D1**: 1 ターン 1 行を `cost_turn` に置く。列は `id`（turn id）・`conversation_id`・`at`・`outcome`・`do_rows`・`do_requests`・`r2_objects`。主キーは `(conversation_id, id)`。月次の合計は `at` の範囲で SUM する（集計行を持たない。二重計上を作らない）。
- **実行中の状態は DO**: 行数の基準（ターン開始時の行数）と計測は Session DO が持つ。跨ぎ検出の状態は持たない（C4 の `prev = new_total - turn_cost`）。
- **provider は既存の行を再利用**: 月次 provider の上限と支出は 0151 の `provider_gateway`（`month_key` / `month_spent` / `month_limit`）を読むだけ。同じ概念を二重に作らない。gateway の 429 は呼び出し単位、こちらは Run を始める前の判定で、二段。
- テーブルと初期値は store の migration 0003（`cost_limits` の 1 行 + `cost_turn`）。上限値はコードに直書きせず、provider_gateway と同じく運用の `UPDATE` で変える。

### 1 ターン 1 行の冪等性

- turn id は RPC の `requestId`（クライアントが渡す再送キー）を使い、無ければ採番する。キーは `(conversation_id, id)` で、pi-durable が requestId を会話に閉じて dedup するのと同じ範囲。`INSERT OR IGNORE` なので同じ会話の再送は行を増やさず、別会話の同じ id は別の行になる（journal の operationId と同じ考え方）。
- `requestId` を渡さない再送は、harness 側でも別の submission になる（pi-durable の requestId が dedup キー）。だから新しい行が増えるのが正しい。

### 計上の時点と outcome

- **失敗したターンも 1 行**。行はすでに書かれているので、上限判定は outcome で絞らない（`completed` + `failed` の合計）。
- outcome は 2 値。`completed` = `session.send` が返った（モデルが答えなかった場合と abort を含む）、`failed` = `session.send` が投げた。abort を別値にしないのは、settlement が「答えた / 答えなかった」しか持たず、理由が自由文で閉じた語彙でないため（文言を解析しない）。
- 記録はターンの終了時。記録自体の失敗でターンを失敗させない（答えたものを消さない）。失敗はログに残すだけで、金額の外側の天井は provider 側の hard limit（0151）。

### 縮退の面

- **Session DO の送信前**（`POST /rpc/conversations/:id/messages` で `session.send` を呼ぶ直前）で止める。新しい Run だけを止め、既存 Run の abort・transcript・一覧は変えない。edge の公開面（`edge/handler.ts`）は共有ファイルなので触らず、RPC の閉じた失敗 union に `limit_exceeded`（429）と `limit_unavailable`（503）を足す。
- ゲージ（D1）が読めないときは **fail closed**（503。上限が読めない状態を「使い放題」と解釈しない）。DB binding 自体が無い環境（ローカルの unit など）はコスト面を配線しない（`DB` は deploy の worker env に既にあり、deploy config は変えない）。
- **migration は Session DO の open でも回す**（`migrateStore`、冪等）。edge の GraphQL 面だけが migrate すると、デプロイ直後の最初の送信が limit 行の不在で 503 になる。DO の open は `blockConcurrencyWhile` の中なので、最初の fetch は migrate の後にしか来ない。
- 上限の比較は「使用量 ≥ 上限」で止める（gateway の `spent + price <= limit` と同じ意味で、上限に達したら次を始めない）。

### アラート

- warn_ratio / critical_ratio は `cost_limits` の列（既定 0.5 / 0.8）。跨いだターンでだけ、metric・level・used・limit の構造化ログを 1 行出す。状態を持たないので再起動でも重複しない（重複排除の表を作らない）。
- 本文・トークン・鍵・provider の応答は出さない（数値と metric 名だけ）。

### token 単位 commit の検出

- テストは「実ターン 1 回の do_rows が閾値以下」を固定する。閾値は 24（0146 の S-03 と同じ規模）。token ごとに commit すれば行数が 100〜500 倍になり落ちる。
- 0169 の `JOURNAL_MAX_ROWS_PER_MUTATION`（1 mutation = 5 行）とは別の問い。あれは Workspace DO の 1 書き込みが設計より多くの行を書かないこと、これは Session DO の 1 ターンが token 単位で書かないこと。**規範はそれぞれ 1 箇所**に置き、二重の正本にしない（この issue は閾値をテストに置き、ランタイムの上限は月次だけ）。

### 実測値の置き場

- **`deploy/limits/RESULTS.md` の 1 箇所**。1 ターンの do_rows / do_requests / r2_objects、月 1 万ターンへの外挿、measure した条件（faux・text only・ツール無し）を書く。docs/limits.md と deploy/limits/README.md から参照する。

## Notes

- 見積り: 月 1 万ターンで Cloudflare は $6〜7。支配的なのはモデル代。
- 設計ミスの例: token 単位 commit で行数 100〜500 倍、mutation ごとの PUT で Class A 増。
- 行数は「書いた行」ではなく「増えた行」（実行前後の COUNT 差）。更新で書き直された行は差に出ないため、do_rows は下限側の推定値。token 単位 commit のような桁の変化はこれで捕まる（0169 の行数テストと同じ計り方）。
- 1 ターンの do_requests は現状 1（送信 RPC 1 回）。0157 で Workspace DO への書き込みが増えたら、同じ記録の列に足す。
- r2_objects は 0 のまま。ターン中の R2 put は 0157 の書き込み経路が入るまで存在せず、列と上限判定だけ先に用意する（同じ概念を作り直さない）。
- 実測の条件: faux provider、text 1 ターン、ツール無し、応答は 200 語（999 文字）、Node SQLite 上の pi-durable。
  応答は Session の runtime factory に注入する（短い既定応答だと delta ごとの commit を検出できない）。

## 未確定

- なし（上限値の初期値は migration 0003 の seed。運用で `UPDATE cost_limits`）。

## やらないこと

- 課金の請求書連携。
- Cloudflare のアカウント使用量 API の取得（この issue は自分が書いた行・リクエスト・オブジェクトだけを数える）。
- ダッシュボード / GraphQL の利用量 UI（0151 の「やらないこと」と同じ。0162）。
- provider 側の hard limit / alert の設定（0151 と docs/auth.md が持つ）。
- 既存 Run の強制停止（縮退は新しい Run を止めるだけ）。

## Result

- verdict: **PASS**（初回 BLOCKED: blocking 1（token 単位 commit の検出テストが既定 faux で検出できない）→ テスト修正 → 再レビュー PASS）
- reviewer: reviewer-0163（この変更を書いていない別エージェント）
- HEAD: 564e4c0（main に ff 統合）
- 受入: 5/5。`npm run check` exit 0（597 tests / 105 files、35.3s。既知の inspector 9229 競合は再実行で green を確認し、隠していない）
- 確認: cost_turn は (conversation_id, id) PK + INSERT OR IGNORE で再送 1 行。200 語（999 文字）の応答で生の行数差 9 を固定し、delta 単位 commit（62 delta）なら 24 を超えて落ちる。cost_limits 1 行（migration 0003、warn 0.5 / critical 0.8）、当月 SUM は at < 翌月。上限超過は Session DO の送信前 429 limit_exceeded、ゲージ不可読は 503 limit_unavailable。既存 Run（abort / transcript）は不変。実 D1 integration 5。
- 計上の限界: cost_turn の INSERT 失敗はターン成功のままログのみ（undercount。金額の外側は provider の hard limit）。DB 不在はローカル unit 専用で、配備は必ず DB を bind する。
- 非 blocking（新規 3・低）: ROW_BUDGET の TSDoc の読み方 / README の「D1 の行数上限」表現 / baseline の実測が添付されていない。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions/D047.md) の採用を受けて）。
- 2026-11-17: 第2波で now へ（0151 の予算と 0153 の R2、0169 の Journal 行数が揃った）。
- 2026-11-17: 第2波でレーン lane-0163。設計（計測の置き場・冪等・計上時点・アラート・縮退の面・実測の置き場）とテスト条件 / テスト設計を追加。touches を実装に合わせて更新（store migration 0003、Session DO の配線、実 D1 integration）。
- 2026-11-17: 実装。`packages/server/src/cost/` に limits（`cost_limits` の 1 行）/ ledger（`cost_turn` の記録と月次 SUM、provider 行の再利用）/ alerts（50% / 80% / 上限の跨ぎ検出）/ meter（DO SQLite の行数）/ gate（admit と turn の編成）を置いた。store に migration 3（`cost_limits` + `cost_turn`、主キーは `(conversation_id, id)`）。Session DO は open 時に `migrateStore` してから gate を作り、messages RPC が `session.send` の前に `admit`、ターンの前後で行数を測って記録する。上限は 429 `limit_exceeded`、ゲージ不可読は 503 `limit_unavailable`。`docs/limits.md` に月次の節、`deploy/limits/README.md` に運用手順、`deploy/limits/RESULTS.md` に実測（1 ターン = 行 9 / リクエスト 1 / R2 0）を置いた。テストは cost の unit 43 + session-rpc 5 + 実ターン 5 + 実 D1 の integration 5。`npm run check` exit 0（597 tests / 105 files、35.7s）。
- 2026-11-17: 実 D1 の integration は cf dev を 1 つ使う。同じ server-integration プロジェクトには gateway と session-do の cf dev も居り、
  wrangler の inspector が全インスタンスで 9229 固定のため、同時起動でどれかが落ちる（`Address already in use (socket "direct:1:default")`）。
  `--inspector-port` を cf に渡しても inspector は 9229 のままであることを実測で確認した（cost 側だけ避ける手段は無い）。
  これは本変更の前からある flakes（本レーン無しの baseline でも再現）で、cost 側は開始を 1 回だけ再試行し、
  両方失敗したら出力を付けて落とす（隠さない）。
- 2026-11-17: 実ターンの計測は faux の text 1 ターン（応答 200 語 = 999 文字）。合計 9 行・内訳・月 1 万ターンへの外挿は
  `deploy/limits/RESULTS.md`。`session-cost.test.ts` は runtime factory に 200 語の応答を注入し、合計 9 行と生の行数差の
  一致を固定する（上限 24 も併せて確認）。短い既定応答では delta ごとの commit を検出できないため。
- 2026-11-17: reviewer-0163 が BLOCKED（blocking 1 / 低 8）。blocking「token 単位 commit を検出できていない」は、
  実ターンのテストが既定の短い応答で 1 delta = 1 commit になり、行数が閾値に収まっていたため。runtime factory へ
  200 語の応答を注入し、合計 9 行を固定 + 生の行数差と一致 + 応答テキストが長文であることを固定した。
  低も反映: inspector の主張を実測に合わせて訂正（9229 固定、再試行で隠さない）、RESULTS の固定範囲を明確化
  （合計 9 は固定、内訳は観察）、README の数値再掲を削除（1 箇所）、当月 SUM に翌月初の上限を追加、コード / テストの
  コメントから issue 番号を削除、DB 不在時の理由と requestId なし再送の但し書きを docs に追加、`cost_turn` の保持と規模を
  README に追加、README の既定値の出所を修正（DO リクエスト 100万は §7 ではなく運用方針）。
- 2026-11-17: reviewer-0163 PASS（blocking 0）。main へ ff 統合（564e4c0）。
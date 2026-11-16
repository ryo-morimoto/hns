# 0151: provider gateway（鍵の分離・予算・緊急停止）

status: open
priority: now
design: agreed
design-ref: D047, D048
depends-on: 0143, 0144
touches: packages/server/src/gateway/, packages/server/test/integration/gateway/, packages/store/src/migrations/, packages/store/test/integration/store/store.test.ts, tools/deploy/, tools/gate/stages.ts, tools/gate/test/stages.test.ts, docs/auth.md, work/issues/0151-provider-gateway.md

## Goal

provider の鍵を harness の isolate から切り離す。harness が汚染されても鍵は盗めず、課金だけが上限で止まる形にする。
gateway は **素の Worker**。予算のカウンタは D1 の 1 文で持つ（DO を作らない。D049）。

## Acceptance criteria

- [ ] gateway は「モデル呼び出し」だけを受ける（任意 URL の proxy にしない）
- [ ] 鍵は gateway の secret のみ。harness 側の env に鍵が無いことをテストで固定
- [ ] 日次・月次の上限を D1 の行に持ち、`UPDATE ... WHERE spent < limit` で原子に判定する
- [ ] 超えたら 429。緊急停止フラグは即時 503
- [ ] 鍵のローテーション手順（停止 → 入れ替え → 再開）
- [ ] provider 側の支出上限とアラートの設定手順

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | harness の env 仕様と配備構成 → provider 鍵の名前を探す → 見つからない（鍵は gateway の secret だけ） | 高 | Goal / auth.md #gateway |
| C2 | gateway → 固定ルート以外（未知パス・GET・上位パス）を呼ぶ → 404 / 405。上流 URL はリクエストのどのフィールドからも選べない | 高 | AC1 |
| C3 | 1 回成功 → 予算の spent が単価ぶん増える。上流が 5xx / 例外 → spent は元のまま（reserve を戻す） | 高 | AC3, 0152 の失敗時 |
| C4 | 残りが単価未満の行 → 呼ぶ → 429、上流に届かない。並行 10 本・上限 3 本ぶん → 成功はちょうど 3 | 高 | AC3, AC4 |
| C5 | `stopped = 1` → 呼ぶ → 503、課金も上流呼び出しもしない。resume 後は通る | 高 | AC4 |
| C6 | DB 未配線 / 単価不正 / 鍵未設定 / 予算行なし → 503（fail closed）、上流に届かない | 中 | Fail closed |
| C7 | 成功・失敗・設定不備のどの応答にも provider 鍵が現れない | 高 | 安全性 |
| C8 | 行の day/month キーが前日・前月 → 予約する → 呼び出しぶんだけでリセットされ、月次は月替わりでリセット | 中 | AC3 |
| C9 | `cf deploy --dry-run` → gateway と main の両方が通る（gate の deploy stage に 2 つ目を足す） | 中 | AC（完了条件） |
| C10 | docs/auth.md の gateway 節 → ローテーション（停止 → 失効 → 新鍵 → 疎通 → 再開）と provider 側 hard limit / alert の手順がある | 中 | AC5, AC6 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 型（コンパイル時）+ 構成テスト | static + unit | `gateway/env.test.ts`（`WorkerEnv` に鍵が増えたら型が落ちる）、`tools/deploy/config.test.ts` "the harness worker declares no provider credential" |
| T2 | C2 | 同値分割 / 境界（パス・メソッド） | unit | `gateway/handler.test.ts` |
| T3 | C3 | 状態遷移（予約 → 成功 / 失敗 → 戻し） | integration | `test/integration/gateway/budget.test.ts` "a failed provider call is refunded" |
| T4 | C4 | 競合（並行）/ 境界値 | integration | 同 "parallel calls stop at the day limit" |
| T5 | C5 | 状態遷移 | integration + unit | 同 "the stop flag refuses every call"、`gateway/handler.test.ts` |
| T6 | C6 | デシジョンテーブル（配線 × 設定） | unit | `gateway/handler.test.ts` |
| T7 | C7 | 契約（応答に秘密が無い） | unit | `gateway/handler.test.ts` |
| T8 | C8 | 境界値（日付・月の跨ぎ） | integration | `/budget` ルート経由で予約日を渡す |
| T9 | C9 | 構成 | integration | `tools/gate/test/stages.test.ts` + dry-run（手動） |
| T10 | C10 | docs review | manual | docs/auth.md |

層の分け方: HTTP の形・閉じた失敗 union・ヘッダの注入は unit（プロセス不要）。D1 の 1 文が原子的か、
日次/月次のリセットは実 D1 が要るので integration（cf dev の workerd + 予算行を seed するテスト専用 worker）。

## Notes

- PoC には無い（faux provider で鍵を使わない）。
- 手元 proxy 案は採らない（トークンが往復し、pi-ai の transport 差し替えが要る）。
- 被害を「金額」に有界にするのが目的。確率の議論をしない。
- D1 の単一行 UPDATE は原子的なので、DO のカウンタは要らない。書き込み頻度はモデル呼び出し単位。
- gateway の面は `POST /v1/<provider>/chat/completions` の固定ルートだけ（ollama-cloud / opencode-go）。
  URL はリクエストから選べず、上流は gateway の env（既定は provider の公式 URL）で決まる。
- 予算は「呼び出し単価 × 回数」。単価は env（`HNS_GATEWAY_CALL_PRICE_USD`）。成功だけ課金し、失敗は戻す。
  単価は許可するモデルの 1 回あたり最大費用に合わせる。金額の最終的な天井は provider 側の hard limit（AC6）。
- 2 つ目の Worker は cf の `cloudflare.config.ts`（1 config = 1 Worker）では表現できないため、
  `tools/deploy/gateway/` を別の cf project にし、gate の deploy stage で 2 つ目の dry-run を回す。

## 未確定

- U-01: gateway をサービスバインディング以外から到達できないようにする（workers.dev の公開）。仮説: 当面は
  予算で金額を有界にし、route を付けない。影響: 認証なしで呼べると予算を先に使い切られる（鍵は漏れない）。
  責任者: lead。トリガー: 0160 で route を付けるとき。

## やらないこと

- OAuth の更新（0128）。
- 利用量の集計 UI（0163）。
- pi-ai を gateway 経由に差し替える配線（0152）。この issue は gateway と予算と配備・文書まで。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: 予算カウンタを D1 に変更（D049）。
- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L9。touches を実パス（`store/src/migrations/`）に直し、gateway Worker の配線として `tools/deploy/` を足した。store migration の枠を持つ。
- 2026-11-17: touches を実装に合わせて直した。integration の置き場を `packages/server/test/integration/gateway/`
  （vitest の project が拾う層）に、2 つ目の Worker の dry-run を gate に足すため
  `tools/gate/stages.ts` / `tools/gate/test/stages.test.ts` を、ローテーション手順と provider 側上限の
  手順を書くため `docs/auth.md` を足した。migration 2 で schema version が上がるため
  `packages/store/test/integration/store/store.test.ts` の期待値を 2 に直した。テスト条件 / テスト設計を記録。
- 2026-11-17: 実装。gateway は `packages/server/src/gateway/`（ルート表・予算・失敗 union・handler・Worker 入口）。
  store に migration 2（`provider_gateway` の1行）。配備は `tools/deploy/gateway/` を2つ目の cf project にし、
  `tools/deploy/modes.ts` に mode の写像を共有化、main Worker に `GATEWAY` service binding を追加、
  `deploy.sh` は gateway → main の順に配備し gateway 用 secrets ファイルを検査する。gate の deploy stage は
  2 つの dry-run を回す。手順は `docs/auth.md` の「gateway（provider 鍵）」に追記（運用 SQL・provider 側上限・ローテーション）。
  `npm run check` の結果はレビュー時に追記する。
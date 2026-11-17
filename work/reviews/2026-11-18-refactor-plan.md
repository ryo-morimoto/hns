# リファクタ束ね方（パッケージ・責務ごと）

出所: 監査（2026-11-18-refactor-audit）・計測（measurements）・ループ trace（loop-trace）。`touches` の衝突を避け、**1 レーン = 1 つの責務のまとまり**として順に main に載せる。

## 束ね方の規則

- **1 レーン = 1 つのパッケージ境界か 1 つの責務**。複数パッケージにまたがる変更（core の語彙追加、失敗 union の統一）は、**core の追加を最初に単独で入れてから**、利用側を後続レーンにする（後続が rebase で追随できる）。
- 同じファイル群を触る項目は同じレーンにまとめる（例: `docs/packages.md` は export 表の修正と所有者の統合を 1 レーンで）。
- `docs/` と `work/BOARD.md` は別セッションが編集中なので、**その commit を待って 1 レーンにまとめる**。
- 各レーンの受入は「秒数 / 行数 / 回数」のどれか 1 つ以上を計測で示す（計測レポートの改善案と対応付ける）。

## レーン（依存順）

| # | レーン | パッケージ / 責務 | まとめる項目 | 受入（計測） | 状態 |
| --- | --- | --- | --- | --- | --- |
| L1 | test 基盤 | `tools/test`, `tools/gate`, 4 integration | P0 cf dev ランチャー、#4 stage 順、#5 in-test build の除去 | 9229 失敗 0 / build 12→0 / 事前 build −13s | P0・#4 完了、#5 レビュー修正中 |
| L2 | `@hns/core` の語彙と契約 | core | request-id の単一定義、署名対象の core 導出、`AbsentVersion`、`EVENT_NAMES` に index.*（語彙だけ）、`OBS_DETAIL_KEYS`→schema の導出、`MAX_INDEX_BATCH` と API 上限の名前分け、`levelOfStatus`、`JOURNAL_UNKNOWN_REASONS` の core 導出 | 重複定義 0（grep）、テスト数 | 未着手 |
| L3 | server の失敗 union と status 写像 | server（edge / files / graphql / do） | 8 union の code→status 表を 1 つに、files face の status 引数削除、GraphQL の failure 型構築の共通化、`console.error` を観測ログへ | union の写像表 1 か所、テスト | 未着手 |
| L4 | server のデータ層と安全 | server / store | D1 の events / usage_log の廃止、未使用 repo の非公開化、DB 不在の fail-closed、journal の二重実装の整理、索引の ORDER BY と式索引 | fail-closed の test、削除行数、EXPLAIN が索引を使う | 未着手 |
| L5 | workspace と machine | workspace / machine | `@hns/workspace/checkpoint` の扱い、tsdown / knip の entry、store の import type 警告、`SignedHeaders` の core 導出の適用 | deploy の警告 0、knip の hint 0 | 未着手 |
| L6 | context と docs | docs / work | AGENTS に規範 356 行を統合、issue の二重 Design を「旧」に畳む、BOARD を now 中心に、D094 / 0230 の番号整理、docs のずれ（packages / workspace / durability / observability / limits / web-client-nfr）、CHANGELOG | レーンの固定読解 1,201 → ~640 行、BOARD 461 → ~80 行 | 別セッションの commit 待ち |
| L7 | 検知力 | tools / CI | `HNS_REQUIRE_CF` / `HNS_REQUIRE_BWRAP` で skip を fail に、0041 の CI で必須化 | skip ガード 25 → fail 経路、CI の必須条件 | 0041 待ち |

## 実行順と並列

- **同時に 2 本まで**（レビューの往復が長いので、実装とレビューを重ねる）。
- L2 → L3 → L4 は依存の一直線（core の語彙 → server の写像 → データ層）。L5 は L2 のあと並列可。L1 は独立。
- L6 は docs の所有者（別セッションの commit）が空いたら最優先で入れる（context がすべてのレーンに効く）。

## 1 レーンで進める手順（trace の改善: 設計 checkpoint と報告の型）

1. 設計 checkpoint: 対象・契約・受入・touches・テスト条件を 1 ページで lead に提出（ループ trace の「BLOCKED の多くは契約の読み違い」への対策）。
2. 実装: まとまった変更をまとめて編集（edit 回数 113/本 を減らす）。テストは絞って回し、**最後に 1 回 full check**（25 回/本 → 5 回以下）。
3. 報告: 結論 → 証拠（数値・file:line）→ 未確認 → 判断が必要な事項だけ質問。中間報告は設計 checkpoint と完了の 2 回まで。
4. lead: 受入と契約の照合 → 独立レビュー → PASS で rebase → gate → ff merge → Result 記録（1〜4 分で済む）。

## L1（test 基盤）完了 — 32e1d6b

- #5 in-test build: 12 → 0、1 package 1 回、assertion / テスト名の差分 0、standalone が dist なしで green（server 359 / machine 60 / workspace 84）。孤児ロックは 1ms で乗っ取り（修正前は Atomics.wait で返らない）。910 tests。wall は 52.5s（変わらない。速くならなかったことを記録）。
- review の低: commit message / measurements の「readLock がディレクトリを読んで EISDIR」という因果は、**fd2a896 には readLock が無く**、この修正の途中案の話。正しくは「ロックに owner 記録が無く、乗っ取りが何を置き換えたか判定できなかった」。measurements の文を直す（次回の L1 追記で）。25s の記録も「返らない」に訂正。

## L2（core の語彙と契約）完了 — a3d024b

- request-id / 署名対象 / AbsentVersion / EVENT_NAMES / DetailSchema 導出 / 定数（core は 50、agent は 500 を INDEX_LIST_LIMIT）/ levelOfStatus / JOURNAL_UNKNOWN_REASONS を core に一元化。利用側の手写が消え、重複 grep 0。918 tests、SDL / codegen 差分 0、署名バイト列は diff 0（reviewer が signatureMessage と署名器のハンク無しを確認）。
- 非 blocking: (1) AbsentVersion は実質 string の別名（Version はもともとブランド無しの string。`"absent"` リテラル主体の設計は follow-up）、(2) SIGNED_FIELDS は写し（Object.values で導出可）、(3) SIGNED_HEADER_BY_FIELD の as は satisfies で塞げる、(4) wire の間接が増えた、(5) `index.legacy_rows` が EVENT_NAMES に無い（L3 で拾う）、(6) wire の新テストは header 名変更時のみ検出。

## L4 への申し送り（L3 から）

- `index.*`（rebuilt / drain.failed / state.failed / legacy_rows）を `ObsLogEntry` で書くと、D1 障害時のテスト環境では 1 ターンで 1 行増える。cost の行数上限（`ROWS_PER_TURN = 10`）と測定窓の定義を L4 で決める: (a) 観測行を窓の外にする、(b) 上限を 11 にする、(c) 障害時は観測を落とす。あわせて `deploy/limits/RESULTS.md` の数値を更新する。
- L3 は語彙・表・写像・型の整理まで。sink は付けない。

## L3 と L5 の切り分け（lead 判断）

- L3（server）: 語彙・status 表・写像・GraphQL の invalid_request 改名と failureType・型の整理まで。`index.*` の sink は付けない。`session-cost.test.ts` の 10 行は変えない。
- L4（server / store のデータ層）に申し送り: `index.*` を ObsLogEntry で書くと D1 障害時に 1 ターン 1 行増える。測定窓の定義（観測行を外す / 上限 11 / 障害時は落とす）と `deploy/limits/RESULTS.md` の更新。

## L5（workspace / machine）完了 — 7ce8626

- `ExpectedVersion` の別名を削除し、core の `AbsentVersion` に統一（grep 0、公開面から消えた）。journal は `MUTATION_UNKNOWN_REASONS` から引く。checkpoint の exports は将来の利用者のため残す（互換を理由にしない）。knip entry の削除で hint 2 → 1（残りは `.agents/**` の意図的 ignore）。store の `import type` で bare import 警告 0。918 tests。
- reviewer PASS。低: checkpoint の @remarks 2 連、tsdown のコメント、docs/workspace の expectedVersion（L6）、journal の reason unit、knip の dist 依存、store の deploy 警告の環境差。
- 判断: `.agents/**` の knip ignore は L6 で消す（knip が exit 0 で hint 0 になることを check で 1 回確認してから）。machine の `SIGNED_HEADERS` / `SignedHeaders` の再公開は残し、「core の写し」と TSDoc に明記する（削除は語彙単一化の再設計後）。

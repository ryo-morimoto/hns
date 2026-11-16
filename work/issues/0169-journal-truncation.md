# 0169: Journal と切り詰め（append・watermark・256KB閾値）

status: done
priority: now
design: agreed
design-ref: docs/durability.md §5
depends-on: 0141, 0156
touches: packages/server/src/do/journal.ts, packages/server/src/do/journal.test.ts, packages/server/src/do/workspace.ts, packages/server/src/do/workspace.test.ts, packages/server/test/support/sqlite.ts, packages/server/test/integration/workspace-do.test.ts, packages/server/README.md, packages/store/src/journal/, packages/store/src/index.ts, packages/store/README.md, work/issues/0169-journal-truncation.md

## Goal

Workspace DO の中の Journal を append 専用にし、checkpoint の watermark で切り詰める。
`journal.json` の全体書き換えをやめ、行数を設計で抑える。

## Acceptance criteria

- [x] イベントは append のみ。seq は DO のトランザクションで採番
- [x] intent / outcome / audit / event を1つの表に持ち、種類で分ける
- [x] 本文は 256KB まで行に持ち、それ以上は R2（0153）に置いて hash だけ残す
- [x] 1 mutation あたりの行数（目安 5）をテストで固定
- [x] checkpoint の watermark を書き、それ以前の intent / outcome / 本文を切り詰める
- [x] 切り詰め後も audit とイベントは残る
- [x] 読み出しは cursor。全件読みをしない
- [x] 再送・二重適用のテスト（operationId）

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 空の Journal → intent / outcome / event を順に append → seq が 1,2,3 で、同時 append でも重複しない | 高 | 受入1・2、durability §1 |
| C2 | 4 種を append → 1 つの表に 4 行あり、kind で形が分かれ、他の表は meta だけ | 中 | 受入2 |
| C3 | 本文がちょうど 256KB → 行に持ち、bucket へ put しない。256KB+1 → R2 に 1 回 put し、行は hash / key / size だけ | 高 | 受入3、§3.1（R2 → DO の順） |
| C4 | bucket の put が null → append は失敗し、行は増えない。同じ operationId・同じ本文の再送 → put は 2 回目をしない | 高 | 受入3、INV-10 |
| C5 | 保存 1 回 → intent + outcome + event の 3 行だけ。再送 → 0 行。拒否 → audit 1 行。どの経路も 5 行以下 | 高 | 受入4、§7（行課金） |
| C6 | intent / outcome / event / audit を append → watermark を書く → 以前の intent / outcome と本文が消え、audit と event は残る。watermark は単調 | 高 | 受入5・6、§5 |
| C7 | outcome の無い intent がある → watermark がそれを越える → 拒否し、watermark は動かない | 高 | 受入5、INV-04（未確定 intent は照合の入力） |
| C8 | 10 行 → cursor で 3 行ずつ読む → 重複・欠落なく昇順で、最後のページに next が無い。limit が範囲外・cursor が不正 → 拒否 | 高 | 受入7、§4 |
| C9 | 同じ operationId で同じ内容の再送 → 記録済み outcome を返し、行は増えない。別内容 → `denied`。outcome に intent が無い → エラー | 高 | 受入8、INV-04 |
| C10 | Workspace DO を実 workerd（cf dev）で起動 → watermark を書き、下げる要求を拒否 → 再起動後も watermark が残り、同じ値の再送は通る | 高 | 受入5、§1（DO SQLite が正本） |
| C11 | 全変更 → `npm run check` → exit 0 | 高 | Result |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 状態遷移 + 競合（同時 append） | unit（実 SQLite） | `src/do/journal.test.ts` "sequence numbers are assigned in order and never repeat under concurrent appends" |
| T2 | C2 | 契約（行の形） | unit（実 SQLite） | "one table holds intents, outcomes, audits, and events" |
| T3 | C3 | 境界値（256KB / 256KB+1） | unit（実 SQLite + fake bucket） | "a body at the inline limit stays in the row and one byte more goes to the bucket" |
| T4 | C4 | 故障注入（put が null）+ 再送 | unit（実 SQLite + fake bucket） | "a refused body write leaves no row and a retry stores the body once" |
| T5 | C5 | 行数の固定 | unit（実 SQLite） | "one mutation appends three rows and a retry appends none" |
| T6 | C6 | 状態遷移（watermark と切り詰め） | unit（実 SQLite） | "the watermark truncates intents and bodies but keeps audits and events" |
| T7 | C7 | 境界値（未確定 intent を越える watermark） | unit（実 SQLite） | "a watermark cannot pass an intent that has no outcome" |
| T8 | C8 | 境界値（cursor・limit） | unit（実 SQLite） | "a cursor reads the journal in bounded pages without skipping or repeating" / "an invalid cursor or an out-of-range limit is refused" |
| T9 | C9 | 同値分割（同じ / 違う operationId 内容）+ 故障（intent 無し） | unit（実 SQLite） | "a retried operation returns its recorded outcome and appends nothing" / "the same operation id with different content is denied" / "an outcome without its intent is refused" |
| T10 | C10 | 実経路（workerd・再起動の永続） | integration（cf dev） | `test/integration/workspace-do.test.ts` "the Workspace DO keeps the journal watermark across a restart" |
| T11 | C11 | ゲート | static / build | `npm run check` |

層の判断: schema・SQL・行数・切り詰め・cursor・重複排除は実 SQLite（node:sqlite、単一プロセス）で証明できるので unit に置く（docs/testing.md の「永続化」に従う）。R2 は fake bucket（外部依存）、実 workerd は DDL と永続の smoke を integration に置く。読み出しの wire 形式（本文を R2 からどう渡すか）は 0155 の面が決めるため、ここでは cursor を返すモジュール契約までにする。

## Notes

- [durability.md](../../docs/durability.md) §5。切り詰めを止めると DO が単調に育つ。
- 行課金は設計で 1000 倍変わる。token 単位の commit をしない。
- Journal の表は Workspace DO の SQLite にあり、D1 ではない。`store/src/migrations/0003` は作らない（D1 の migration は制御データ用）。DDL は `@hns/store/journal` が持ち、DO が開くときに `CREATE TABLE IF NOT EXISTS` する（0156 の版・lease と同じ）。
- テストは vitest の include に合わせて `src/do/journal.test.ts` に置く（0156 と同じ。`test/do/` は実行されない）。
- 未確定 intent がある間は watermark を進めない（INV-04 の照合入力を消さない）。checkpoint の watermark は 0154 が `POST /rpc/journal/watermark` を呼ぶ。
- 切り詰めは R2 の object を消さない。参照されない body の GC は 0168。
- append は「R2 → DO」の順なので、R2 に置いた後で重複拒否・ロールバックになった body は参照されない object として残る（GC は 0168）。
- watermark の RPC は lease を要求しない。checkpoint は Run の終わりで、lease の扱いは 0154 が決める。RPC は内部（Worker の binding 経由）で、edge の公開面には出さない。
- Journal の配線は「保持と watermark」まで。`apply` が intent / outcome を書くのは 0157（0156 の Result のとおり）。イベント語彙は `@hns/workspace` の `FILE_EVENT_KINDS` と同じで、1箇所に寄せるのは DO 経路へ移すとき（0157 以降）に行う。
- `journal_meta` は seq と watermark を持つ meta 表で、entry は `journal` の1表だけ。

## やらないこと

- checkpoint の commit 作成（0154）。
- 保持と GC（0168）。
- restore と、Journal を読む wire 形式（0155）。

## Result

- verdict: **PASS**（reviewer-0169、blocking 0）
- reviewer: reviewer-0169（この変更を書いていない別エージェント）
- HEAD: 4fc9c7c（main に ff 統合）
- 受入: 8/8。`npm run check` exit 0（549 tests / 98 files、36.0s）
- 確認: append-only（INSERT のみ、UPDATE は meta の seq / watermark）、seq は transaction で採番。1 表に 4 種を kind で持ち、CHECK と parser で閉じる。256KB ちょうどは行内、+1 は R2 に 1 回 put してから行を確定（失敗時は行なし）。watermark は未確定 intent を越える要求と後退を 409。cursor は keyset、operationId の再送は outcome を返す。実 SQLite の unit 16 + cf dev の watermark 永続 1。
- 非 blocking（低 8、follow-up）: コードの TSDoc に issue 番号（0168 / 0154）/ watermark が未来の seq を受理し得る（0154 は commit 前に N を捕捉）/ unsafe integer は 500 / CHECK の説明が parser の不変条件より強い / read で sha256 を再計算しない / read が body を全件 materialize（0155 で byte 上限）/ docs/packages の store 説明が journal を反映していない / 語彙の手写しが core と部分集合でしか結ばれない・行数定数を API で強制していない。

## Log

- 2026-11-07: 作成（0156 から分割。D048）。
- 2026-11-17: 第2波で now へ（0153 の R2 ストアと 0156 の Workspace DO が揃った）。
- 2026-11-17: 実装前のテスト分析・設計を追加（C1–C11 / T1–T11）。`touches` を実装に合わせて更新: テストは include に入る `packages/server/src/do/journal.test.ts`、store の公開面 `packages/store/src/index.ts`、DO 配線の `packages/server/src/do/workspace.ts`、共有する SQLite fake の `packages/server/test/support/sqlite.ts` と `workspace.test.ts`、cf dev の `workspace-do.test.ts`。`store/src/migrations/0003` は不要（DO の表は DO が作る）。
- 2026-11-17: 実装。`@hns/store/journal` に1表（`journal`）の DDL・行 schema・`parse`・本文の object key と語彙を置き、`packages/server/src/do/journal.ts` に append（intent / outcome / audit / event）・operationId の再送照合・operationId ごとの unique 部分 index・cursor 読み出し・watermark と切り詰めを実装。本文は 256KB まで行、超えるものは `env.OBJECTS` に1回 put してから行を確定する。`Workspace` は Journal を初期化し、`POST /rpc/journal/watermark` を公開（下げる要求と未確定 intent を越える要求は 409）。unit 16（実 SQLite、fake bucket、同時 append・境界・故障・再送）+ DO の unit（watermark RPC）+ cf dev の integration 1。`npm run check` exit 0（549 tests / 98 files）。
- 2026-11-17: reviewer-0169 PASS（blocking 0）。main へ ff 統合（4fc9c7c）。低 8 を Result に記録。
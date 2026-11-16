# 0192: findings 13 件を再判定し、直す

status: open
priority: batch
design: agreed
design-ref: 設計を変えない（findings の再判定）
depends-on: 0145, 0146
touches: work/findings/, packages/server/src/edge/, packages/store/src/, packages/core/src/types.ts, packages/core/test/, packages/workspace/src/workspace.ts, packages/workspace/test/

## Goal

`work/findings/findings.jsonl` の open 13 件を fixed / rescope / still-open / obsolete に振り分け、直す。
registry を信頼できる状態に戻す。

## Problem / context

13 件が open のまま。うち F-0010（`store/db.ts` は既に `IsoTimestampSchema` を import している）と
F-0023（`agent/tools.ts` は既に `operationIdFrom` を import している）は修正済みに見える。
F-0011 の location は 0188 で消えた `packages/core/src/http.ts` を指している。
registry が実態とずれると、レビューで同じ指摘を蒸し返すか、逆に見落とす。

## Acceptance criteria

- [ ] 13 件すべてに判定を付ける（fixed は証拠、rescope は新しい location、obsolete は理由）
- [ ] `findings.jsonl` は追記のみ。訂正は新しい entry の `supersedes`
- [ ] still-open は修正 + 回帰テスト（`// Catches:` を付ける）
- [ ] F-0011 は `core/src/types.ts` の `last_fired_at` コメントに rescope する（「minute」の記述が残っている）
- [ ] F-0023 は 0146 の統合後に確認する（`packages/agent/src/tools.ts` は 0146 の所有）
- [ ] `jq -r 'select(.status=="open") | .id' work/findings/findings.jsonl` が 0146 待ちだけになる
- [ ] `npm run check` が通り、独立レビューが PASS する

## 判定の候補（実測で確定する）

| id | 現在の location | 候補 | 根拠 |
| --- | --- | --- | --- |
| F-0009 | `store/src/db.ts` | still-open | 既定 clock が open 時の値を返す |
| F-0010 | `store/src/schemas.ts` | fixed か rescope | `db.ts` は core の schema を import 済み。scan の範囲を確認 |
| F-0011 | `core/src/http.ts`（消滅） | rescope → `core/src/types.ts` | 「minute」のコメントが残る |
| F-0021 | `workspace/src/workspace.ts:269` | still-open | `auditLog` は内部配列をそのまま返す（0190 と同時に直す） |
| F-0022 | `core/test/codecs.test.ts` | still-open | ownership scan が literal のみ |
| F-0023 | `agent/src/tools.ts` | fixed か rescope | `operationIdFrom` を import 済み。0146 後に確定 |
| F-0024 | `workspace/test/hardening.test.ts` | still-open | traversal 形の operationId ケースが無い |
| F-0025 | `store/src/repositories/automations.ts` | still-open | 非 ISO の createFiring.at のテストが無い |
| F-0026–F-0029 | `docs/packages.md` / `server/src/edge/*` | still-open | 0145 の review 残件 |

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | still-open の各件 → 修正後のコード → finding の observation が再現しない | 高 | 受入3 |
| C2 | 修正した各件 → テスト → 回帰を捕まえる（壊すと落ちる） | 高 | 受入3 |
| C3 | registry の全 entry → 集計 → open が 0146 待ちだけ | 高 | 受入6 |
| C4 | 全変更 → `npm run check` → 通る | 高 | 受入7 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C2 | 回帰（修正前に落ちることを確認） | unit / integration | finding ごとの既存ファイルの隣 |
| T2 | C3 | 集計 | manual / static | `jq` の出力を結果に貼る |
| T3 | C4 | ゲート | static / build | `nix develop --command npm run check` |

## Notes

- F-0021 は 0190 の `auditLog` 修正と同じ変更。0190 が先なら「fixed」で閉じる（重複作業をしない）。
- F-0023 の確認だけは 0146 の統合後。それ以外は 0190 と独立に進められる。
- 指摘の severity は変えない。blocking のまま close しない。

## やらないこと

- 新しい指摘の追加（レビューは別）。
- `findings.jsonl` の既存行の書き換え。

## Log

- 2026-11-11: 作成。13 件のうち 4 件は修正済み・1 件は location 消滅の疑い。

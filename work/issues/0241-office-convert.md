# 0241: PDF への変換を machine の書き込み経路で行う

status: open
priority: next
design: agreed
design-ref: D103, docs/office.md
depends-on: 0236
touches: packages/core/src/machine.ts, packages/machine/src/operations.ts, packages/machine/src/office/, packages/server/src/do/workspace.ts, packages/server/src/do/machine.ts

## Intent

「渡す」ための出力。プレビューと違い、成果物はユーザーのファイルとして残る。Worker の body 上限（16 MiB / 1 MiB）
を通らない経路が要る。31 MB の PDF を既存の write で運ぶ設計は成立しない（レビュー B4）。

## Goal

`office(convert)` が cache に PDF を作り、**既存 write 経路の変種**で版を照合して ROOT に資産化する。失敗時は何も残さない。
応答はパスとバイト数だけで、バイト列は Worker を通らない。

## Acceptance criteria

- [ ] convert は**既存 `write` op の変種**で書く（`content` の代わりに構造化 `source: { kind: "office-cache", workspaceId, pathHash, version, file }`、bytes は machine が cache から読む）
- [ ] `contentHash` を必須にし、machine が cache のバイト列の sha256 を照合してから rename する
- [ ] `output` は `{ path, expectedVersion, operationId }`。結果は `applied` / `conflict` / `unknown`（応答断は `unknown`、stat で照合）
- [ ] journal・版・`file.write` 監査は既存の write 経路がそのまま記録する（server の後追い反映を作らない）
- [ ] 既存ファイルがあるときは `expectedVersion` が一致しない限り `source_changed`（上書きしない）
- [ ] 出力名（`(2)` を付ける等）は**呼び出し側**が決める。machine は与えられたパスに書くだけ
- [ ] 100 MiB までの出力を書ける（31 MB の実測を含む）
- [ ] 失敗時に半端なファイルを残さない（temp → rename）
- [ ] 監査に出力先とバイト数だけを残す（内容は残さない）

## テスト条件

- C1: docx → PDF → ファイルが増え、原本が無傷
- C2: 既存 PDF と競合 → `conflict`、既存は無傷
- C3: 31 MB の PDF（実測の xlsx）→ 書ける
- C4: 変換中の kill → 残骸が残らない
- C5: 監査に内容が無い
- C6: 応答断（kill）→ `unknown`、再照合で applied か未適用に決まる
- C7: 改竄した `source`（`pathHash` に `..` 等）→ `path_denied`、ワークスペースに何も出ない
- C8: `contentHash` が cache のバイト列と違う → `engine_failed`、書き込みなし

## テスト設計

- T1: C1/C2 → integration（workspace の版を見る）
- T2: C3 → 大きい fixture → integration（体感の上限確認）
- T3: C4/C5 → 故障注入・監査 → integration / unit

## Problem / context

machine の 1 リクエストは 16 MiB（base64 で実効 ~12 MiB）、DO はそれより大きい書き込みを 413、edge の files 面は
1 MiB の文字列。スパイクの 31.2 MB PDF はこの経路で書けない。machine が ROOT に書けば、Worker はバイト列を持たない。

## Users and use cases

- 利用者: 作った文書を PDF で配れる。
- エージェント: 変換結果をパスで案内できる。

## Non-goals

- PDF 以外の形式（D102）。
- 印刷設定の UI。
- 再計算（0242 の sidecar）。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | machine が版照合の内側で ROOT に書く | 大きい出力・版・監査が 1 本 | machine に書き込み権限の設計が要る（0194） | 中 | 中 |
| B | Worker 経由で書く | 既存経路 | 16 MiB / 1 MiB で不可能 | 高 | — |
| C | 外部サービスに書かせる | 実装が軽い | D102 に反する | 高 | 中 |
| Do nothing | 変換しない | 安全 | 渡せない | 中 | — |

## Recommendation

A。INV-O6 として契約に入れ、版照合は machine の内側（既存の write と同じ規則）で行う。

## Design: guide-level

```
office_convert(path, { to: "pdf" }) → 提案書.pdf（名前は呼び出し側が決める）
```

## Design: reference-level

- 書き込みは temp（同じディレクトリ）→ fsync → rename。rename 前に magic（`%PDF-`）を検証。
- 版の照合は既存の write と同じ（`expectedVersion` と現在の版）。
- 応答は `{ path, bytes }`。監査は `office.job` に to / bytes。

## Invariants and failure modes

- INV-O1（原本を変えない）・INV-O4（半端を残さない）・INV-O6（machine が書く）。
- 途中で落ちたら temp を消し、既存は触らない。

## Cross-cutting concerns

- security: 出力パスも ROOT 内に正規化（既存の resolve）。
- cost: 変換は 2〜17 秒。実行枠は 0236 と共有（同時 1）。
- observability: 出力先・バイト数・ms。

## Compatibility, migration, rollback

office op は常に cache に作る（資産化しない）。資産化は write 変種の `source` を使う別の 1 手。ロールバックは `source` の削除。

## Test plan

integration（成功・競合・大出力・残骸）、unit（パスと magic の検証）。

## Rollout and graduation

0236 と同じ flag。Phase 2 の完了 = 変換が E2E で通る。

## Notes

- 大きさの根拠: S12（31.2 MB PDF）、S25。

## 未確定

- U-01: 出力名の規則（`(2)` か日時か）/ 仮説: `(2)`、呼び出し側が決める / 影響: UX / 責任者: user / トリガー: 0240 の設計時。

## やらないこと

- PDF 以外への変換、印刷設定、再計算。

## Log

- 2026-11-17: 作成。
- 2026-11-17: 独立レビュー 1 回目を受け、convert のみに分割し、machine の書き込み経路（INV-O6）へ変更。
- 2026-11-17: レビュー 2 回目（N5/N13）対応: operationId と unknown、server の後追い反映、touches を machine.ts に。
- 2026-11-17: レビュー 3 回目（O3/O14）対応: 既存 write の変種へ。
- 2026-11-17: レビュー 4 回目（P3）対応: 構造化 source・contentHash 必須・sha256 照合・改竄テスト。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

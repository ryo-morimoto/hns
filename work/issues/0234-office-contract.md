# 0234: Office の契約を core に固定する

status: open
priority: now
design: agreed
design-ref: D102, D103, docs/office.md
depends-on: —
touches: packages/core/src/office.ts, packages/core/src/office.test.ts, packages/core/src/machine.ts, packages/core/package.json, packages/core/tsdown.config.ts, packages/core/test/fixtures/office/, docs/office.md, docs/packages.md

## Intent

Office の 4 レーン（machine / server / web / agent）が同じ語彙で並列に進めるように、型・schema・エラー・上限・
machine の wire への追加を最初に固定する。ここが動くと全レーンが壊れる。だから契約だけを独立した issue にする。

## Goal

`@hns/core` に `OfficeJob` / `OfficeResult` / `OfficeLimits` / `OFFICE_ERROR_CODES` / `EngineManifest`、
machine の `op: "office"` / `op: "officeEngine"` の request/result、`MACHINE_ARTIFACT_PATH` / `artifactTarget()` /
`officeParamsHash()`、write の `source` 変種と `artifact.sha256` が入り、下流は import するだけで実装を始められる。

## Acceptance criteria

- [ ] `packages/core/src/office.ts` を `@hns/core/office` として export する（package.json と tsdown の設定を含む）
- [ ] `OfficeInput` に `workspaceId` を含み、`version` は `sha256:<hex>` として検証される
- [ ] `packages/core/src/machine.ts` の request/result に `op: "office"` と `op: "officeEngine"` を足す（既存 op の受理は後方互換。バイナリ配信は HTTP route なので JSON の型は増やさない）
- [ ] `docs/office.md` §2 の `OfficeCommand`（3 語彙）と `CellEdit` を型と fixture に含める
- [ ] `MACHINE_ARTIFACT_PATH`・`artifactTarget()`（query の正規形）・`officeParamsHash()` を core に置く（server と machine が同じ関数を使う）
- [ ] `op: "officeEngine"` の request/result を machine の型に足す
- [ ] `MachineWriteRequest` に `source: { kind: "office-cache", workspaceId, pathHash, version, file }` の変種（`content` と排他）を足し、`contentHash` を必須にする
- [ ] `OfficeArtifact` に `sha256` を含める
- [ ] 型は `types.ts` ではなく `office.ts` が正本。schema は `v.GenericSchema<unknown, T>` で型に整合する
- [ ] 閉じた union の `switch` が `never` で網羅される（テストで固定）
- [ ] golden fixture（job 3 = preview/render/convert、result 4 = 3 + `officeEngine`、error 3、拒否 3、
      `OfficeCommand` 3 種と `CellEdit`、write 変種（source + contentHash）、`artifact.sha256`）を `packages/core/test/fixtures/office/` に置き、通る
- [ ] `docs/office.md` の §2・§9・§10・§11 と一致する
- [ ] `npm test -w @hns/core` が通る

## テスト条件

- C1: 未知の `operation` / 未知の `error.code` → schema が拒否する
- C2: `operation: "preview"` に `commands` を混ぜた JSON → 拒否する
- C3: `version` が `sha256:` でない / `workspaceId` が無い → 拒否する
- C4: golden fixture 12 件（成功 6・拒否 6）→ 期待どおり
- C5: 型と schema の不一致 → コンパイルエラー（型テストで固定）
- C6: `limits` の負値・0 → 拒否する

## テスト設計

- T1: C1〜C3・C6 → 閉じた union と境界値 → unit → `office.test.ts`
- T2: C4 → fixture の table-driven → unit
- T3: C5 → `expectTypeOf` / `node:assert` の型テスト → unit
- T4: 網羅性 → `switch` の `never` → unit

## Problem / context

4 レーンは独立に実装できるが、語彙がずれると後から全部を直すことになる。スパイクで「型→操作→保存」の流れは
確認済み（S23）。契約を先に固定すれば、レーンは別々のファイルを触ったまま並列に進められる。

## Users and use cases

- 実装者（machine）: 型を見て prescan と実行を書く。server の都合を知らずに済む。
- 実装者（web）: `PreviewStatus` の 7 状態だけを見て UI を書く。
- レビュアー: 契約の差分だけを見れば 4 レーンの整合を確認できる。

## Non-goals

- 実行・保存・UI（0236 / 0237 / 0238）。
- ODF / CSV 等の形式（D102 で対象外）。
- pack の manifest 読み込み（0235 / 0236）。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | 契約を `@hns/core` に置く | 依存線を増やさない。全レーンが同じ型を見る | core が太る | 低 | 小 |
| B | machine に置き server が複製する | core が太らない | 複製が drift する。契約が 2 つになる | 高 | 中 |
| C | GraphQL SDL だけを契約にする | アプリ契約と一致 | 内部の job / wire 型が無い | 中 | 中 |
| Do nothing | 各レーンが独自の型を持つ | すぐ書ける | 統合で全部やり直し | 高 | 大 |

## Recommendation

A。既存の依存規則を 1 本も増やさず、全レーンが同じ型を共有できる唯一の場所。B は drift が構造的に起きる。

## Design: guide-level

```ts
import type { OfficeJob } from "@hns/core/office";

const job: OfficeJob = {
  v: 1, id: "office-1750", operation: "preview",           // id は OperationId（[A-Za-z0-9_-]{1,64}）
  input: { workspaceId: "ws-1", path: "提案書.docx", version: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", format: "docx" },
  limits: { maxInputBytes: 52_428_800, maxCells: 300_000, maxPixels: 24_000_000,
            timeoutMs: 60_000, maxOutputBytes: 104_857_600 },
};
```

## Design: reference-level

型・schema・エラー・上限・manifest の意味は [docs/office.md](../docs/office.md) §2・§5・§9・§10・§11。
machine の wire への追加は §5（`output` の有無で convert を表す）。

## Invariants and failure modes

- 未知の値は拒否する（既定値に落とさない）。
- 追加は optional field のみ。破壊は v2。
- fixture は「通る例」と「拒否する例」の両方を持つ。

## Cross-cutting concerns

- security: パスは文字列のまま（解決は machine）。
- observability: 監査の field 名を型で固定する（0237 が使う）。
- performance: 影響なし。

## Compatibility, migration, rollback

新規ファイル + machine wire への 1 op 追加（後方互換）。ロールバックは op と file の削除。

## Test plan

unit のみ（core）。fixture は `packages/core/test/fixtures/office/`（既存の `test/fixtures` 配置に合わせる）。

## Rollout and graduation

下流の 4 レーンが import を始めたら凍結。以降の変更は契約変更として別 issue。

## Notes

- 設計の背景: [work/research/office-architecture.md](../work/research/office-architecture.md) §3。
- 決定: D102（エンジン）、D103（保存と配信）。

## 未確定

- U-01: `render` を独立 operation にするか `preview` の `format` で表すか / 仮説: 独立 / 影響: 0236 と 0240 / 責任者: user / トリガー: 0236 の実装前。

## やらないこと

- 実行・保存・UI・resolver。
- manifest の読み込み。
- 形式変換の語彙拡張。

## Log

- 2026-11-17: 作成。
- 2026-11-17: 独立レビュー 1 回目（blocking 10）を受け、workspaceId・version 形式・machine 型・fixture 配置・touches を修正。
- 2026-11-17: レビュー 2 回目（N11/N12/nit）対応: OfficeCommand の定義と fixture、touches に docs/office.md、version の実値。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

# 0240: エージェントに Office のツールを与える

status: open
priority: next
design: pending
design-ref: 未（D091 の capability 契約と docs/office.md に合わせて設計レビュー）
depends-on: 0220, 0221, 0236, 0241, 0242
touches: packages/agent/src/office-tools.ts, packages/agent/src/tools.ts, packages/core/src/capability/, packages/core/src/office.ts

## Intent

エージェントが文書を「読む・見る・直す・渡す」ための面を作る。実行は machine、面は agent。
capability 契約（D091）の閉集合にツールを足すので、risk と scope を先に決める。

## Goal

`office_render`（PNG）/ `office_inspect`（構造）/ `office_edit`（テキスト・セル・数式）/ `office_convert`（PDF）の
4 ツールで、docx / xlsx / pptx を扱える。失敗は型付きコードで返り、モデルが次の手を選べる。

## Acceptance criteria

- [ ] 4 ツールとも strict schema。未知の引数は拒否
- [ ] `office_inspect` は構造を JSON で返し、大きな結果はページングする
- [ ] `office_render` は指定ページの PNG を返し、モデルに画像として渡る
- [ ] `office_edit` は 3 語彙（テキスト・セル・数式）を適用し、新しい版として保存する
- [ ] `office_convert` は PDF を書き、既存を上書きしない
- [ ] `ToolId` に 4 つ追加（risk: render/inspect は read、edit/convert は write）。**policy の既定は off**
- [ ] manifest の descriptionHash/parametersHash が固定され、0221 の呼び出し同一性に乗る
- [ ] 監査に argsHash が載り、本文・セル値は載らない
- [ ] 版不一致は `source_changed`、未対応のコマンドは `unsupported_command`

## テスト条件

- C1: 3 形式の inspect → 構造（ページング含む）
- C2: render 1 ページ → PNG、幅が指定どおり（上限 1600）
- C3: edit 3 語彙 → 新しい版、変更パーツが最小
- C4: convert → PDF、既存は無傷
- C5: 版不一致 / 未知のコマンド → 何も書かない・型付き
- C6: policy 既定 off → 呼ぶと `tool_disabled`
- C7: 監査に本文が無い

## テスト設計

- T1: C1/C2 → fixture 3 形式 → integration
- T2: C3/C4 → 編集・変換 → integration（パーツ差分）
- T3: C5〜C7 → 故障注入・policy → unit / integration

## Problem / context

スパイクで、編集は document.xml / slide1.xml の 1 パーツに閉じ、xlsx は式と計算値を書けることを確認（S23）。
一方、複雑な構造（表・図・グラフ）の編集は未検証。v1 の語彙を絞らないとモデルが壊す操作を許す。

## Users and use cases

- 利用者: 「表の金額を 10% 上げて」「PDF で出して」が通る。
- エージェント: 画像で確認してから直せる。
- レビュアー: risk と scope を 1 か所で確認できる。

## Non-goals

- 書式・画像・表・グラフの編集。共同編集。PDF 以外への変換。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | 4 ツールを別 ID で | risk を分けられる | ツールが 4 つ増える | 中 | 中 |
| B | 1 ツール + command 文字列 | 面が小さい | 引数検証が弱い・risk を分けられない | 高 | 中 |
| C | MCP サーバを別に立てる | 他製品と共通 | 認可・監査が別系統 | 高 | 大 |
| Do nothing | ツール無し | 安全 | 利用者がスクリプトを書く | 中 | — |

## Recommendation

A。D091 の契約に乗せ、read と write で risk を分け、既定 off から始める。

## Design: guide-level

```
office_inspect(path)                                  → { format, pages, structure }
office_render(path, { pages: [2], width: 1280 })      → PNG（モデルに画像として渡る）
office_edit(path, { commands: [{ op: "setCells", sheet: "売上", cells: [{ ref: "B12", value: { kind: "formula", formula: "=SUM(B2:B11)" } }] }] })
office_convert(path, { to: "pdf" })                   → 提案書.pdf
```

## Design: reference-level

- ツールは `OfficeJob` に変換して machine に渡す。独自の実行経路を作らない。
- `edit` の語彙は `docs/office.md` の `OfficeCommand`（3 種）に限定。
- `ToolId` の閉集合を変える影響: policy 文書の既定（off）、manifest の hash、0221 の呼び出し同一性、0226 の実行経路。
- 画像は `GET /artifact` で読み、tool の出力として image を返す（pi の tool 出力の image 形式）。専用の attachment 面は作らない。

## Invariants and failure modes

- 編集は新しい版（INV-O1）。失敗時は何も書かない。
- 監査に本文・セル値を入れない。
- 画像はワークスペースを汚さない（INV-O3）。

## Cross-cutting concerns

- security: パスの封じ込めは machine。モデルの引数をそのままパスにしない。
- cost: render はページ数と幅で上限。
- accessibility: 画像の alt はページ番号。

## Compatibility, migration, rollback

`TOOL_IDS` の追加（後方互換）。既定 off なので既存セッションは影響を受けない。ロールバックはツールの削除。

## Test plan

unit（引数検証・写像・manifest hash）、integration（3 形式の inspect / render / edit / convert）、監査。

## Rollout and graduation

既定 off → workspace のポリシーで有効化。Phase 1 の完了 = 4 ツールが E2E で通る。

## Notes

- 編集の実測: [ibisoffice-spike](../work/research/ibisoffice-spike/README.md)（S23）。
- 契約: [docs/capability.md](../docs/capability.md) / [docs/office.md](../docs/office.md)。

## 未確定

- U-01: 4 ツールを別 ID にするか 1 ID + risk で分けるか / 仮説: 別 ID / 影響: policy / 責任者: user / トリガー: 設計レビュー。
- U-02: edit の語彙を v1 で 3 種に絞るか / 仮説: 絞る / 影響: 体験 / 責任者: user / トリガー: 設計レビュー。
- U-03: tool から machine への配線（`do/machine.ts` を再利用するか `do/session.ts` 経由か）/ 仮説: 0237 の port を再利用 / 影響: touches / 責任者: user / トリガー: 0240 の設計レビュー。

## やらないこと

- 書式・表・画像・グラフの編集。
- リアルタイム共同編集、MCP サーバの新設。

## Log

- 2026-11-17: 作成。
- 2026-11-17: 独立レビューを受け、0220/0221 への依存、policy 既定 off、manifest hash、width の統一、touches を修正。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

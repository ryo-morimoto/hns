# 0242: Office の sidecar（inspect / edit / recalc）を作る

status: open
priority: next
design: pending
design-ref: 未（fork か upstream かを設計レビューで決める。D102 の前提条件を更新する）
depends-on: 0235, 0236
touches: tools/office-sidecar/, tools/office-pack/, packages/machine/src/office/, docs/office.md

## Intent

release の AppImage は `--export pdf/png` しか持たない。inspect / edit / recalc には実行バイナリが存在しない（レビュー B1）。
このまま pack の manifest と 0236 の op を宣言すると嘘になる。sidecar を別 issue にして、誰がどう作るかを決める。

## Goal

`ibis-pptx` + `ibis-calc`（+ 必要なら `ibis-doc-model`）をリンクした sidecar バイナリが、JSON（stdin/stdout）で
inspect / edit / recalc を提供し、pack に同梱される。machine はこの sidecar を既存の op の裏で呼ぶ。

## Acceptance criteria

- [ ] 版を固定したソース（commit + sha256）から、再現可能にビルドできる（`tools/office-sidecar/build.sh`）
- [ ] protocol v1: `{ op: "inspect" | "edit" | "recalc", input, commands? }` → `{ ok, result | error }`
- [ ] docx のテキスト挿入が `word/document.xml` の 1 パーツだけを変える（S23 の再現）
- [ ] xlsx のセル設定が式と計算値を書き、自己往復でバイト同一（S23 の再現）
- [ ] pptx の図形テキストが `ppt/slides/slideN.xml` の 1 パーツだけを変える
- [ ] 未対応のコマンドは `unsupported_command` で失敗し、**部分適用しない**
- [ ] `recalc` は式を値に置き換えず、計算値を新しい版に書く（式は残す）
- [ ] `recalc` はブック全体を対象にする（選択シートは将来）。未対応関数は `unsupported_command` で何も書かない
- [ ] `recalc` の値は、Excel が保存した値との一致 fixture で確かめる（`calc_check` 方式）
- [ ] pack の manifest に `inspect` / `edit` / `recalc` を追加（sidecar の版も記録）
- [ ] AGPL の対応ソースに sidecar の改変を含める
- [ ] 失敗時に一時ファイルを残さない

## テスト条件

- C1: docx のテキスト挿入 → 1 パーツのみ変更
- C2: xlsx のセル設定 → 式 + 値、自己往復でバイト同一
- C3: pptx の図形テキスト → 1 パーツのみ変更
- C4: 未対応コマンド → 部分適用なし
- C5: ビルド 2 回 → 同じ sha256（再現性）
- C6: 不正な JSON / 大きな入力 → 型付きエラー
- C7: recalc → 値が入り、式が残り、未対応関数は何も書かない
- C8: recalc の値 → Excel の保存値と一致（fixture）

## テスト設計

- T1: C1〜C3 → 実 fixture → integration（パーツ差分）
- T2: C4/C6 → 故障注入 → unit / integration
- T3: C5 → 再ビルド → integration
- T4: C7/C8 → recalc の値と式の保持、Excel 保存値との一致（`calc_check` 方式）→ integration

## Problem / context

上流の #159（MCP サーバー提案）は open で、ヘッドレス文書サービスの API は未実装。release バイナリにも無い。
スパイクでは 50 行の Rust バイナリで docx/xlsx/pptx の編集が通った（S23）ので、実現性は確認済み。
問題は「誰が持つか」（上流に返すか、hns が fork を持つか）と、AGPL の対応ソースの扱い。

## Users and use cases

- エージェント: inspect / edit / recalc のツール（0240）が動く。
- 運用者: pack 1 つで 6 op が揃う。
- 法務: sidecar の改変も対応ソースに含める。

## Non-goals

- 書式・表・図・グラフの編集。
- 上流の MCP サーバそのもの（#159 が実装されたら合流する）。
- GUI の再現。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（当面採用） | hns が固定版の fork を持ち、sidecar をビルド | すぐ作れる。版を固定できる | fork の維持・AGPL のソース管理 | 中 | 中 |
| B | 上流 #159 に合流して API を待つ | 維持が軽い | 時期が読めない。今は無い | 中 | 小 |
| C | release バイナリだけで済ませる | ビルド不要 | inspect/edit/recalc が無い | 高 | — |
| Do nothing | 3 op を出さない | 嘘をつかない | 編集ができない | 中 | — |

## Recommendation

**A（当面）→ B（合流できるなら移行）**。まず fork で sidecar を作り、上流に提案を出して受け入れられたら
fork を捨てる。C は要件を満たさない。

## Design: guide-level

```bash
tools/office-sidecar/build.sh          # 固定ソースから sidecar を作る
echo '{"op":"inspect","input":"a.docx"}' | office-sidecar
```

## Design: reference-level

- protocol は stdin に 1 行 JSON、stdout に 1 行 JSON。ログは stderr。
- 編集は `Command` / `FlowCommand` / `SheetCommand` の 3 語彙に限定（docs §2 の `OfficeCommand`）。
- 保存は temp → rename。元ファイルを直接書き換えない。
- ソースは submodule か vendored tarball（版 + sha256）。ビルドは nix か rustup の固定版。

## Invariants and failure modes

- 失敗時は何も書かない（部分適用禁止）。
- 未対応の変更は黙って捨てずに `unsupported_command`。
- 版の互換は protocol v1 で固定（field 追加のみ）。

## Cross-cutting concerns

- security: 入力は untrusted。zip の展開上限（0236 の prescan と同じ）を sidecar 側でも守る。
- compliance: sidecar の改変を対応ソースに含める（AGPL §6）。
- operability: ビルドが再現可能（版の固定）。

## Compatibility, migration, rollback

pack の manifest に op を追加するだけ。sidecar を外せば 3 op が `unsupported_command` になる。

## Test plan

integration（3 形式の編集・再計算・未対応・再現性）。fixture はスパイクの `ja-business.docx` 等を使う。

## Rollout and graduation

sidecar が入った pack で 0236 の op を有効化 → 0240 のツールを有効化。

## Notes

- 実測: [ibisoffice-spike](../work/research/ibisoffice-spike/README.md)（S23）。
- 上流: [ibisjp/ibis-office#159](https://github.com/ibisjp/ibis-office/issues/159)。
- D102 の「ヘッドレス API が公開されないまま…」の前提条件は、この issue の判断で更新する。

## 未確定

- U-01: fork を持つか upstream に PR するか / 仮説: まず fork、上流に提案 / 影響: 維持コスト・AGPL / 責任者: user / トリガー: 設計レビュー。
- U-02: ソースの持ち方（submodule か vendored tarball）/ 仮説: vendored tarball + sha256 / 影響: ビルドの再現性 / 責任者: agent / トリガー: 実装時。
- U-03: protocol の版（v1 で固定）/ 仮説: v1 / 影響: 将来の互換 / 責任者: user / トリガー: 実装時。

## やらないこと

- 書式・表・図・グラフの編集。
- 上流 MCP サーバの実装そのもの。
- Windows / macOS の sidecar。

## Log

- 2026-11-17: 作成（レビュー B1 への対応）。
- 2026-11-17: レビュー 2 回目（N6）対応: recalc の受入とテスト（式の保持・未対応関数・Excel との一致）を追加。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

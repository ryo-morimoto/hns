# 0190: workspace の低負債を一括で閉じる（0056・0057・0058・0060）

status: in-progress
priority: now
design: agreed
design-ref: 設計を変えない（0056–0060 の欠陥返済）
depends-on: 0045
touches: packages/workspace/, work/issues/0190-workspace-debt.md

後継: 0056・0057・0058・0060 を吸収する。

## Goal

0056（temp の後片付け）・0057（journal の temp 名）・0058（auditLog の不変性）・0060（helper 応答の長さ）を
1本で閉じる。どれも `packages/workspace` の中だけで完結する。L4（0153 / 0154 / 0155）が同じファイルを
書き始めると毎回 rebase になるので、**窓が開いているうちに**済ませる。

## Acceptance criteria

- [x] 0056: conflict / unknown で終わる write の temp を残さない。`#removeTemp` の失敗を audit に残す
- [x] 0056: 起動時に root 直下の `.hns-tmp-*` を掃除する。Journal の pending intent が指す temp は消さない
- [x] 0057: journal の temp 名に `randomUUID()` を付ける
- [x] 0057: 同じ journalPath の二重 open は `Unavailable` で拒否する（fail closed）
- [x] 0058: `auditLog` は写し（または凍結）を返し、呼び出し側の変更が次の読みに出ない
- [x] 0058: 同じ扱いが要る他の getter を確認する（`mode` を除く）
- [x] 0060: helper の `read` 応答に `size` を足し、復号後の長さを照合する。違えば `failed("io")`
- [x] 上記それぞれに回帰テストを足す
- [ ] `npm run check`（workspace の全層）が通り、独立レビューが PASS する

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | conflict で終わる write → root を見る → `.hns-tmp-*` が残らない | 高 | 0056 |
| C2 | temp の remove が失敗する → audit → 失敗が記録される（黙って捨てない） | 中 | 0056 |
| C3 | pending intent が temp を指す状態で open → 掃除 → その temp は残る | 高 | 0056 |
| C4 | 同じ journalPath を2つの Workspace が開く → 2つ目 → `Unavailable` | 高 | 0057 |
| C5 | 保存が失敗する → 次の保存 → 前の temp が次を壊さない | 中 | 0057 |
| C6 | `auditLog` を取得して push → もう一度取得 → 追加が現れない | 高 | 0058 |
| C7 | helper が cut した base64 を返す → read → 壊れた内容を返さず `failed("io")` | 高 | 0060 |
| C8 | 全変更 → `npm run check` → 通る | 高 | 受入8 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C3 | 状態遷移の境界 | integration | `packages/workspace/test/`（既存 hardening / journal の隣） |
| T2 | C4–C5 | 競合 + 失敗注入 | integration | 同上（2プロセスまたは2インスタンス） |
| T3 | C6 | 不変性 | unit | `packages/workspace/src/workspace.test.ts` |
| T4 | C7 | 故障注入 | unit | protocol の parse テスト（切れた応答 fixture） |
| T5 | C8 | ゲート | static / build | `nix develop --command npm run check` |

## Notes

- 順序は 0057 → 0056 → 0058 → 0060。0057 と 0056 は同じ temp / journal を触るので、0057 を先にすると 0056 の掃除条件が1つに決まる。
- `docs/workspace.md` は 0141 が持つ。必要なら 0141 の統合後に1行足す（この issue では触らない）。
- 0056 の「置き場所を制御用ディレクトリへ逃がす」案は別の判断。ここでは採らない。
- 0057 の二重 open は同一プロセス内の claim（絶対 journalPath の Set）で拒否する。別プロセス間の検出は `docs/workspace.md` の「保証しない」に含まれるため行わない。保存 temp の UUID で衝突だけを消す。
- 0056 の起動時掃除は root 直下の通常ファイル `.hns-tmp-*` だけを対象にする。一覧が取れない場合は開くのを止めず、削除の失敗は audit に残す。

## やらないこと

- 0172（0191 が引き取る）。
- 0055 / 0061（0169 の redesign で型ごと作り直す）。
- journal の切り詰め（0169）。
- セキュリティ境界（probe の条件、dirfd の検証）の変更。

## Log

- 2026-11-11: 作成。0056・0057・0058・0060 を吸収（L4 が workspace を書く前の窓）。
- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L4。3本のうちの1本で、workspace の窓を閉じる。
- 2026-11-17: 実装。0057（journal の claim と保存 temp）→ 0056（temp の掃除と audit）→ 0058（auditLog の写し）→ 0060（helper read の size 照合）。回帰は設計どおり T1–T4: `temp.test.ts`（C1–C3）、`journal.test.ts`（C4–C5）、`workspace.test.ts`（C6）、`protocol.test.ts`（C7）。
- 2026-11-17: `npm run check` exit 0（28.5s、system node 24.22.2）。独立レビュー待ち。

# 0191: workspace の実行性能を測って固定する（0172 の引き取り）

status: open
priority: plan
design: pending
depends-on: 0190
touches: packages/workspace/src/rooted.ts, packages/workspace/src/workspace.ts, packages/workspace/src/protocol.ts, packages/workspace/test/, tools/gate/

後継: 0172 を吸収する。

## Goal

dirfd モードが操作ごとに node プロセスを起動しているのをやめ、ゲートの時間を測って固定する。
実行時の性能と、integration テストの時間の両方に効く（D060 の計測）。

## 事実（実測、0172 から）

| 操作 | rooted 有効（dirfd） | rooted 無効（checks） |
| --- | --- | --- |
| open（probe 1回） | 77.7ms | 2.7ms |
| write（hash + commit の2回） | 154.6ms | 2.5ms |

`Rooted.#call` は毎回 `env.exec([process.execPath, helper, ...])` を起動する。
そのため workspace のテストは1件あたり約300msかかり、integration 層が12.5秒になっている。

## Acceptance criteria

- [ ] 1ワークスペース1プロセス（常駐）か、hash + commit の1往復化のどちらかを選び、理由を Log に書く
- [ ] 既存の TOCTOU / hardening / workspace のテストが全層で通る
- [ ] 実測: write が 10ms 未満、integration 層が 3秒未満（before / after を表で残す）
- [ ] ヘルパーが落ちたときの扱いを決める（再起動 / checks へフォールバック / 失敗）
- [ ] `npm run check` の出力にパッケージごとのテスト時間が残る
- [ ] `npm run check` が通り、独立レビューが PASS する

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 同一の拒否ケース（TOCTOU・hardening・traversal）→ 新しい経路 → 同じ結果で拒否される | 高 | 受入2 |
| C2 | ヘルパーが異常終了する → 次の操作 → 決めた扱いどおりになる（黙って成功しない） | 高 | 受入4 |
| C3 | 同じ workload → 計測 → write < 10ms、integration < 3s | 中 | 受入3 |
| C4 | ゲート実行 → 出力 → パッケージごとの時間が読める | 低 | 受入5 |
| C5 | 全変更 → `npm run check` → 通る | 高 | 受入6 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 既存ケースの再利用 | integration | `packages/workspace/test/` の既存 suite をそのまま通す |
| T2 | C2 | 故障注入 | integration | ヘルパーを強制終了する fixture |
| T3 | C3–C4 | 計測 | manual / static | issue に表を残す。ゲートの集計を1フィールド足す |
| T4 | C5 | ゲート | static / build | `nix develop --command npm run check` |

## Notes

- 常駐化は**安全性の向上にもなる**。dirfd を開いたままにできるので、親の差し替えに対する窓がさらに狭くなる。
  ただしライフサイクル（close・異常終了・タイムアウト）とプロトコルの多重化を決める必要がある。
- 安い切り口は hash + commit の1往復化（変更が小さく、効果は約半分）。
- 0190 の後に置く。同じ `workspace.ts` を触るので直列。

## やらないこと

- セキュリティ境界の変更（probe の条件、dirfd の検証）。
- ゲート全体の高速化（0041 / 0172 の範囲外）。

## Log

- 2026-11-11: 作成。0172 を吸収し、計測の固定を足した。

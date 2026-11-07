# 0172: rooted ヘルパーの起動を操作ごとにしない

status: open
depends-on: -
touches: packages/workspace/src/rooted.ts, packages/workspace/src/workspace.ts, packages/workspace/src/protocol.ts

## Goal

dirfd モードの書き込みが **操作ごとに node プロセスを起動している**のをやめる。実行時の性能と、integration テストの時間の両方に効く。

## 事実（実測）

| 操作 | rooted 有効（dirfd） | rooted 無効（checks） |
| --- | --- | --- |
| open（probe 1回） | 77.7ms | 2.7ms |
| write（hash + commit の2回） | 154.6ms | 2.5ms |

`Rooted.#call` は毎回 `env.exec([process.execPath, helper, ...])` を起動する（`packages/workspace/src/rooted.ts`）。
そのため workspace のテストは1件あたり約300msかかり、integration 層が12.5秒になっている。

## Acceptance criteria

- [ ] 1ワークスペースにつきヘルパーを1プロセスだけ起動し、複数の操作を処理させる（あるいは hash と commit を1往復にする）
- [ ] 既存の TOCTOU / hardening / workspace のテストが全層で通る
- [ ] 実測: write が 10ms 未満、integration 層が 3秒未満
- [ ] ヘルパーが落ちたときの扱い（再起動するか、checks モードに落とすか）を決める

## Notes

- 常駐化は**安全性の向上にもなる**。dirfd を開いたままにできるので、親の差し替えに対する窓がさらに狭くなる。ただし
  ライフサイクル（close・異常終了・タイムアウト）とプロトコルの多重化を決める必要がある。
- 先に hash + commit の1往復化だけをやる案もある（変更が小さく、効果は約半分）。

## やらないこと

- セキュリティ境界の変更（probe の条件、dirfd の検証）は変えない。

## Log

- 2026-11-07: 作成（0170 の計測で判明）。

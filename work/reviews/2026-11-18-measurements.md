# 計測レポート（2026-11-18 / read-only）

対象: main b44c4e1。meter が 18:10–18:35 に計測。前後で git status と生成物のハッシュが不変。

## A. context

| 対象 | 行 | token @40 |
| --- | ---: | ---: |
| AGENTS.md | 202 | 8,080 |
| docs/ 全体（41 files） | 5,902 | 236,080 |
| work/issues/（199 files） | 14,579 | 583,160 |
| work/BOARD.md | 461 | 18,440 |

- 1 レーンの必須: AGENTS 202 + testing 195 + parallel-change 161 + issue 平均 172 + 直近 Result 10 = **740 行 / ~29.6k token**。BOARD を足すと **1,201 行 / ~48k token**。
- issue の平均 172 行（最大 0149 の 280）。**設計が二重**（0149 は「Design（D078）」76 行と「Design（実装）」56 行が併存）。
- 同時編集: main の未コミット **84 パス**（issues 60 / research 16 / docs 4）、BOARD +46/−21。worktree 3、.agents/worktrees 2.3 GB。

## B. CI / gate（1 回実測）

| stage | ms | 構成比 |
| --- | ---: | ---: |
| lint | 487 | 1.1% |
| fmt | 60 | 0.1% |
| codegen | 293 | 0.7% |
| typecheck | 932 | 2.1% |
| test | 27,282 | 62.3% |
| build | 11,843 | 27.0% |
| deploy | 1,977 | 4.5% |
| knip | 917 | 2.1% |
| 合計 | 43,791 | 100% |

- test の壁は 1 ファイル: session-do.test.ts 25.1s（stage の 92%）。cf dev 5 ファイル = 23 tests（2.6%）が test 時間の 70%。
- unit tier 15.45s のうち web 15.14s、Shell.test.tsx 12.77s（22 tests、84%）。
- build は 8 パッケージ逐次 11.8s。check の前に npm run build すると **+11.6s の二重実行**。
- 規範は 1 issue あたり full check **3 回**（lane / review / main）→ 131s/issue、12 レーンで 26 分/日。0163 は 6 本。
- cf dev の 9229 競合は 7 本中 1 本（14–29%）。1 回の実コストは 19.3s の失敗 + 36.7s の再実行 = **56s**。
- 当日 14 時間で test stage 11.3s → 27.3s（+141%、規範の警報線 2 倍を踏んだ）。

## C. テストの質

- 133 files / 876 tests / 798 blocks / 2,170 expect（2.7/block）。実行時 skip 0（cf 不在時は 25 の skipIf ガード、bubblewrap 8）。
- アサーション 0 の block は **0**、presence のみ **9/798（1.1%）**、// Catches: **435/798（54.5%）**、層重複 4 組。
- **「弱いテストが多い」は成立しない。** 問題は (a) 23 tests が test 時間の 70%、(b) skipIf(!cf) 25 箇所で cf dev tier が丸ごと緑のまま消える、(c) bubblewrap 8 本が skip された実績。
- 遅くて signal が低い候補: Shell.test.tsx 12.8s / gateway/budget 6.0s（純ロジックを実 cf dev 越し）/ workspace-integration dirfd 33.7s / session-do の WS 認証 3.3s / workspace-do の DDL 再構築 2.7s。

## 改善案（削減見込み）

| # | 案 | 見込み |
| --- | --- | --- |
| 1 | Shell.test.tsx を 4 ファイルに分割して並列化 | web ゲート −9〜10s |
| 2 | cf dev tier を pre-commit から外す / session-do を 15s 未満に分割 | test −11s |
| 3 | build を selection.packages に限定 | −10.3s |
| 4 | check 前の npm run build を禁止 | −11.6s |
| 5 | cf dev の共有ランチャー + ロック（P0 で実行中） | flake 56s × 14–29% を 0 に |
| 6 | vitest --isolate=false | −1.27s |
| 7 | CI では cf / bubblewrap 不在を fail（skip を失敗に） | 検知力の回復 |
| 8 | 上書き済み Design を畳む | −120 行/レーン |
| 9 | 規範 356 行を AGENTS の節に統合し必要節のみ読む | −178 行/レーン |
| 10 | BOARD を now のみ（~80 行）に | −380 行/着手 |

合算: full check **43.8 → 21〜24s（−45〜52%）**、web コミットのゲート 17 → 7s、レーン固定読解 1,201 → ~640 行（−47%）。

## 実施結果

- #1 Shell テストの分割（28b84f1）: vitest --project web は 14.50 → 6.16s（−8.3s / −57%）、Shell 系は 1 ファイル 12.5s → 4 ファイル並列 4.2/3.3/3.0/2.3s。web の commit gate 17 → 6.8s。22 tests は 1:1、assertion 82 個の multiset 一致、shuffle でも green。check は 55.3s（test 38.9s）。

- #4 stage 順（2787390）: STAGES を build → test に。指定 build ありの 68.5s → 事前 build なしの 55.4s（−13.1s / −19%）。fresh・dist なしの check が exit 0（reviewer 57.4s、888 tests）。回帰テスト（indexOf build < test）と docs/parallel-change の追記。

- #5 in-test build の重複除去（fd2a896, 修正 commit は続く）: 4 つの cf dev suite が each beforeAll で `npm run build` していたのを `tools/test/ensure-dist.ts` に置換。判定は「exports の import 先が存在（isFile）かつ src/ の新しいファイルより古くない」で、current なら build を呼ばない。suite は別 worker で同時起動するため tmpdir のディレクトリロックで直列化し、owner 記録（pid/at/token）の pid が死んでいれば即時乗っ取り、2×BUILD_TIMEOUT_MS を超えたら年齢で乗っ取る（SIGKILL / gate キャンセルの孤児ロック対策）。

  **受け入れ条件は「check が速くなる」ではなく次を満たすこと**（計測の都合上、壁時計は変わらないため）:
  - in-test build **12 回 → 0 回**（check、dist あり/なし両方で 0。NODE_OPTIONS で execFileSync をフックし npm build の spawn を実数カウント）
  - 1 package 1 回（standalone: server/machine 各 4 回 = core/store/agent/server、workspace 1 回。旧は同一パッケージを並行 worker が二重ビルドしていた）
  - assertion / テスト名の差分 **0**（4 ファイル、件数 16/31/21/20 が前後一致）
  - standalone が dist なしで green（server 359 / machine 60 / workspace 84 tests）
  - **wall は変わらないことを記録**: 前 57.1s（test 39.4s）→ 後 52.9–58.6s（test 36.3–42.3s）。gate は build→test 順なので in-test build は元々「直後に上書きされるだけの冗長 spawn」で、直列 check の壁時計には現れなかった。実利は冗長 spawn の除去と並行レースの解消。

  検証: dist なし check exit 0・910 tests（52.9s）、dist あり exit 0・910 tests（58.6s）、どちらも in-test build 0。test は 900 → 910（ensure-dist.test.ts 22 本を追加）。

  レビュー指摘の修正: ロックを owner 記録（pid/at/token）付きディレクトリにし、pid が死んでいれば即時・2×BUILD_TIMEOUT_MS 超なら年齢で乗っ取る（SIGKILL / gate キャンセルの孤児ロックで 300s 固まる blocking を解消）。再現テスト「an orphan lock does not stall the next build queue」は修正前の readLock に戻すと 25s で kill されることを確認済み。あわせて dist の isFile 判定、export のパッケージ外参照の拒否、同時刻を current とすることのコメント、packages/web の除外理由の TSDoc、ロック判定の純関数化（judgeLock/parseLock/sameRecord）と単体テストを追加。

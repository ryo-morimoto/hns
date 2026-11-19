# 0141: 耐久の契約（ack の故障クラス・checkpoint・restore）

status: done
priority: now
depends-on: 0140
touches: docs/durability.md, docs/workspace.md, packages/core/src/durability.ts, packages/core/src/durability.test.ts, packages/core/src/index.ts, packages/core/README.md, packages/core/CHANGELOG.md, work/issues/0141-durability-contract.md

「保存した」と言ったあと、どの故障まで耐えるかを `(C, J)`・故障クラス・RPO・restore の4点で固定する。
正本は [docs/durability.md](../../docs/durability.md) に置き、実装は 0153〜0169 に分ける。

## Goal

「保存した」と言ったあと、どの故障まで耐えるかを決めて型と文書にする。
checkpoint の単位と restore の手順を、以後の実装が迷わない形で固定する。

契約は [docs/durability.md](../../docs/durability.md) に書いた。正本は `(C, J)`（最後の checkpoint と、
その後の確定済み Journal）。作業ツリーは写像であり、失ってよい。

## Acceptance criteria

- [x] 故障クラス表: プロセス crash / 電源断 / マシン喪失 / アカウント事故のそれぞれで、ack 済み保存・agent の変更・会話 / Journal・戻し方を書く
- [x] ack の意味: エディタ保存とツール呼び出しは **Workspace DO の outcome 確定後**（≤256KB は DO の1トランザクション、>256KB は R2 → DO）。agent の shell 変更は Run 終了時の checkpoint まで
- [x] durable の単位は `(C, J)`（checkpoint commit と、その後の確定した Journal）と定義
- [x] restore の順序: base の展開 → Journal の seq 順再生 → 未確定 intent を `unknown` として照合（INV-04）→ root 同一性の確認
- [x] RPO の数値目標（ack 済み 0 / agent 変更は 1 Run）を文書に書く
- [x] `docs/workspace.md` の「rename の耐久性を保証しない」を、誰がいつ埋めるかに置き換える
- [x] `docs/durability.md` を正とし、Session DO / Workspace DO / R2 の分担を core の型に落とす
- [x] INV-09（正本は `(C, J)`）と INV-10（ack は単一システム）が ARCH にある（0140 と調整）
- [x] `npm run check` と独立レビュー PASS を `## Result` に記録する

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `docs/durability.md` の故障クラス表 → 4 行すべてに「ack 済み保存 / agent 変更 / 会話・Journal / 戻し方」がある | 高 | 受入1 |
| C2 | ack の記述 → D048 と一致し、≤256KB は DO のみ、>256KB は R2 → DO の順になっている | 高 | 受入2 |
| C3 | `(C, J)` と restore の記述 → C 展開 → J の seq 順 → unknown 照合の順序が一致する | 高 | 受入3・4 |
| C4 | RPO 表 → ack 済み 0 / agent 1 Run の数値目標があり、アカウント事故が除外されている | 高 | 受入5 |
| C5 | `docs/workspace.md` → 古い「保証しない」が、0141 の契約と 0157 の ack に置き換わっている | 中 | 受入6 |
| C6 | core の語彙 → docs の 4 failure class / 3 authority と一致する | 中 | 受入7 |
| C7 | ARCH → INV-09 / INV-10 が存在する | 低 | 受入8 |
| C8 | 全変更 → `npm run check` が通る | 高 | Result |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C5 | 文書レビュー | manual / static | 独立レビューで表と本文を照合 |
| T2 | C6 | 契約テスト | unit | `packages/core/src/durability.test.ts` |
| T3 | C7 | 静的確認 | static | `ARCH.md` の INV 表を grep |
| T4 | C8 | ゲート | static / build / integration | `nix develop --command npm run check` |
| T5 | ack / restore / 故障注入の実挙動 | — | — | **0141 ではテストしない**。0155 / 0157 / 0167 が証明する |

## Problem / context

いまの v0.1 はディレクトリの fsync をしない。ack 直後に電源が落ちると、保存したはずの rename が消え得る。
R2 はこれを解決しない（消えたものは送れない）。ack の意味をローカルの rename に置いたままでは、
マシン喪失とアカウント事故のどちらにも答えられない。

D047 で正本を Cloudflare に置き、D048 で正本の単位を `(C, J)`、ack を単一システムで閉じると決めた。
残っているのは、その決定を「どの故障に耐えるか」「何を ack と呼ぶか」「どう戻すか」まで下ろすこと。
M6 の 0146〜0169 は、この契約を前提に Session DO / Workspace DO / R2 を実装する。

## Users and use cases

- **エディタで保存する operator**: 保存の応答を受け取ったあと、プロセス crash・電源断・マシン喪失のどれでも内容が戻ってほしい。いまはローカルの rename に依存し、ディレクトリの fsync をしないため ack の保証が無い。
- **shell を実行する agent**: `npm install` や `git` の変更は Run の終わりにまとめて確定してよい。Run の途中で落ちた変更の耐久が保証されないことは受け入れるが、どこまで戻るかを知りたい。
- **マシンを失った operator**: 新しいマシンで `(C, J)` から戻したい。ack 済みの保存は byte 一致で戻り、最後の checkpoint 以降の agent の変更は戻らないと説明できる必要がある。

## Non-goals

- R2・checkpoint・restore・Journal の実装（0153〜0169）。0141 は契約と型だけ。
- 定期的な checkpoint。Run の終了時だけ打つ（U-25 で決定済み）。
- アカウント事故からの自動復旧、別リージョンへの自動フェイルオーバー、exactly-once。
- provider の鍵（0143）。GraphQL への投影。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A | ローカル fsync + git のみ（do nothing） | 追加実装が無い | マシン / アカウント喪失で失う。ack と正本が一致しない | 高 | 低 |
| B | C（checkpoint commit）だけを正本にする | restore が1段で単純 | checkpoint 後の ack 済み保存が戻らない（RPO > 0） | 高 | 低 |
| C | `(C, J)`（採用） | ack 0、cross-machine、restore が決定的 | DO / R2 依存、J の切り詰めが必要 | 中 | 中 |
| D | 書き込みごとに R2 オブジェクトを正本にする | 読みが単純 | ack が R2 に結合、RTT と費用、J の順序が無い | 中 | 中 |

A は現状維持で、故障クラス表の「マシン喪失」「アカウント事故」に答えられない。
B は restore が単純だが、最後の checkpoint 以降の ack 済み保存を失うため RPO 0 を満たさない。
D は R2 を書き込みの直列化点にしてしまい、ack が R2 の可用性に結合する。C だけが goals を満たす。

## Recommendation

C を採る。`(C, J)` を正本とし、ack は Workspace DO の outcome と同一トランザクションで閉じる。
大きい本文だけ R2 → DO の順にし、R2 を ack より先に確定させる。

前提:

- Workspace DO が 1 ワークスペースの書き込みを直列化する。
- R2 は checkpoint commit の object を保持する。
- ack の p95 は 150ms 以下（[docs/durability.md](../../docs/durability.md) §10 の撤退条件と同じ）。

前提が崩れたら、ExecutionEnv と Storage の境界でローカルに戻す（[0166](0166-migration-rollback.md)、[docs/durability.md](../../docs/durability.md) §10）。

## Design: guide-level

エディタで保存し、`applied` を受け取ったとする。この保存はプロセス crash・電源断・マシン喪失のどれでも戻る。
戻らないのは、Cloudflare アカウントごと失う事故だけ（0164 の backup / export が唯一の経路）。

agent が shell でファイルを変えた場合、その変更は Run の終わりに checkpoint として確定する。
Run の途中でプロセスが死ぬと、その Run の未確定変更は durable でない（同じマシンに残ったツリーを次の checkpoint が拾い得るが、保証しない）。これは受け入れた RPO の帰結で、定期 checkpoint はしない。

マシンを失った場合は、新しいマシンで C を展開し、J を seq 順に再生する。
ack 済みの保存は byte 一致で戻り、最後の checkpoint 以降の agent の変更は戻らない。

## Design: reference-level

型は `@hns/core` の `durability.ts` に置く。

- `FAILURE_CLASSES` / `FailureClass`: `process-crash` / `power-loss` / `machine-loss` / `account-incident`。
- `DURABILITY_AUTHORITIES` / `DurabilityAuthority`: `session-do` / `workspace-do` / `r2`。D1 は再構築できる索引で、machine とブラウザは正本ではない。
- `CheckpointRef`: `workspaceId` / `runId` / `commit`。C を指す。
- `DurableUnit`: `checkpoint` と `throughSeq`。`throughSeq` 以下は C に畳まれ、restore はそれより大きい確定 Journal を昇順に再生する。

ack の順序:

1. ≤256KB: `intent` → マシンで適用 → `outcome` + 新しい版 → ack（DO の1トランザクション）。
2. >256KB: `intent` → マシンで適用 → R2 に本文 → `outcome` + 版 → ack。R2 が先。

checkpoint は Run の終了時に、作業ツリーを commit にして `refs/hns/checkpoints/<runId>` を進め、R2 に pack を送り、
watermark を書いて J を切り詰める。Run の中断・キャンセルは後始末の checkpoint を打つが、プロセスの crash は後始末を実行できないため含めない。restore は C を展開し、J を seq 順に再生し、未確定 intent を `unknown` として照合し、
`.hns/root.json` で復元先の同一性を確認する。

契約の詳細は [docs/durability.md](../../docs/durability.md) §1（故障クラス / RPO）、§3（ack）、§5（checkpoint）、§6（restore）。

## Invariants and failure modes

- INV-03: 版付き書き込みは古い内容を黙って上書きしない。Workspace DO の直列化とマシンの再ハッシュの二段。
- INV-04: 再送は既存結果を返すか照合する。intent が先、outcome が後。`unknown` を applied / conflict に丸めない。
- INV-05: checkpoint と外部 Mutation は別トランザクション。U は Run 境界で commit 化されるまで durable でない。
- INV-09: 正本は `(C, J)`。作業ツリーは写像であり、失ってよい。
- INV-10: ack は単一システムで閉じる（DO の1トランザクション、または R2 → DO の順）。

死んだ窓は3つ（intent 後・適用後 / outcome 前・outcome 後 / 応答前）。どれも再送とハッシュ照合で閉じる。
Run の途中でプロセスが死ぬと、その Run の U は durable でない（同じマシンに残ったツリーを次の checkpoint が拾い得るが、保証しない）。「中断・キャンセル」の checkpoint は後始末を実行できる停止だけを指し、プロセスの crash は含まない。checkpoint の途中で死んだ場合、watermark が無ければ J は残り、restore は C に戻る。

## Cross-cutting concerns

- **Security**: 正本への経路は Worker / DO / machine の署名付き経路だけ。R2 と DO を公開しない。root 同一性は `.hns/root.json` で確認する。Journal に秘密を入れない。
- **Observability**: `workspaceId` / `runId` / `operationId` / `seq` / watermark を相関 ID に載せる。ack の p95、Journal の行数、checkpoint の成否、restore 演習の結果を記録する（0162 / 0163）。
- **Operability**: ack p95 > 150ms / Journal の単調増加 / checkpoint 失敗で 0166 の撤退条件を検討する。restore の runbook は 0164。
- **Cost**: 容量ではなく行数と往復で決まる。月1万保存・8KB なら DO でも R2 でも無料枠。罠は token 単位の commit、J を切り詰めないこと、イベントごとの D1 同期更新。
- **Performance**: 保存の p95 は 150ms 以下を目標にする。未計測の値は「推定」と明記し、0157 / 0167 で測る。

## Compatibility, migration, rollback

- `Workspace` の API と `MutationResult` は変えない。変わるのは ack の意味で、0157 が DO 経由にする。
- 保存形式の変更はない。core への追加は型と語彙だけで、既存の呼び出しに影響しない。
- DO を経由しない書き込み経路は 0157 で閉じる。混在時の拒否は lease / epoch（0142）で行う。
- 戻すときは ExecutionEnv と Storage の境界でローカルに戻す（0166）。`(C, J)` の定義と restore の手順はそのまま使える。

## Test plan

- C1–C5 は文書レビューと独立レビューで証明する（散文をテストにしない）。
- C6 は `packages/core/src/durability.test.ts` の契約テストで証明する。
- C7 は `ARCH.md` の INV 表を静的確認する。
- C8 は `nix develop --command npm run check`。
- ack / restore / 故障注入の実挙動は 0155 / 0157 / 0167 が証明する。0141 では実装しない。

## Rollout and graduation

M6 の契約として先に固定し、0153〜0169 がこの契約に従って実装する。
監視と abort 条件は [docs/durability.md](../../docs/durability.md) §10。段階的な canary は無い（契約と型のみ）。

## Notes

- 決定は D047 / D048。0141 はその契約で、新しい DNNN は追加しない。
- checkpoint は `git stash create` 相当の commit を `refs/hns` に作り、ユーザーのブランチを動かさない。`.gitignore` 対象は含めない。
- 故障注入の既存の形は 0002。リモート経路は 0167 が同じ形で再検証する。
- `refs/hns` の保持と GC は 0168。restore の runbook は 0164。
- `throughSeq` の非負・単調は TSDoc の不変条件で、型では強制しない。0155 の入力境界で parse する。

## 未確定

- U-25: 解決済み（D048）。checkpoint は Run の終了時（中断・lease 解放・正常終了を含む）。定期 checkpoint はしない。
- U-26: アカウント事故からの復旧経路 / 0164 の backup・export / 影響: 契約は「保証しない」で固定 / 責任者: user / トリガー: 0164。
- U-27: checkpoint の保持数と R2 の GC / 0168 / 影響: RPO ではなく費用と復帰時間 / 責任者: user / トリガー: 0168。

## やらないこと

- R2 の実装（0153）、checkpoint の実装（0154）、restore の実装（0155）、Journal の実装（0156 / 0169）。
- 定期的な checkpoint。
- アカウント事故からの自動復旧、別リージョンへの自動フェイルオーバー、exactly-once。
- provider の鍵（0143）。GraphQL への投影。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions/D048.md) の採用を受けて）。
- 2026-11-07: 契約を [docs/durability.md](../../docs/durability.md) に書いた（`(C, J)`・ack の順序・checkpoint の契機・費用の見方）。残りは core の型と workspace.md の更新。
- 2026-11-11: RFC / design doc の形に再構成。故障クラス表・RPO 表・テスト条件 / 設計・代替案・compatibility を追加。core の型と workspace.md を更新。
- 2026-11-11: `work/BOARD.md` / `work/LANES.md` を `touches` から外した（lead 所有）。
- 2026-11-11: 独立レビュー PASS（blocking 0）。full check は他レーンの未コミット変更が fmt / lint で落ちるため、統合時に再実行する。
- 2026-11-16: full `npm run check` が exit 0（277 tests / build / deploy dry-run / knip）。受入 9/9 で done。

## Result

- 独立レビュー: durability-reviewer-2 / **PASS** / HEAD 13e6486（作業ツリー）/ blocking 0
- `npm run check`: exit 0（lint / fmt / typecheck / 277 tests / build / deploy dry-run / knip、22.2s）
- 受入: 9/9。文書・型・テスト・ARCH の確認は完了。
- 非 blocking（レビュー comment）: 電源断行の「失われる」と本文の「残らないことがある」の表現差、`DURABILITY_AUTHORITIES` の R2 説明、core README の消費 issue 範囲、§8/§10 の監視条件の具体化、T1 に C6 の docs 突合を含める。

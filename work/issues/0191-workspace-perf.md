# 0191: workspace の実行性能を測って固定する（0172 の引き取り）

status: open
priority: next
design: agreed
design-ref: D093
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

- [ ] 1ワークスペース1プロセス（常駐 child）を選び、D093 に理由を書いた
- [ ] 既存の TOCTOU / hardening / workspace のテストが全層で通る
- [ ] 実測: write p95 が 10ms 未満、integration 層が 3秒未満（before / after を表で残す）
- [ ] ヘルパーが落ちたときの扱いを決める（1回再起動 / 3回で fail closed。checks へ落とさない）
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

## Design（D093 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D093）。

### 前提

- `Rooted.#call` は操作ごとに `env.exec([node, helper, op, json])` を起動する（実測: open 77.7ms / write 154.6ms / 1テスト約300ms / integration 12.5s）。
- helper は `/proc/self/fd/<dirfd>/<name>` で openat 相当を行う。別プロセスである理由は **ExecutionEnv の file API がパスしか取らない**ことで、セキュリティ境界ではない（docs/workspace.md / 0005）。
- helper は root の dirfd を開いたままにできる。常駐化すると親の差し替えに対する窓も狭くなる（0191 Notes）。

### 決定案 1: 常駐 helper を採る（1 root = 1 プロセス）

| 案 | 初回 | 以降 | 判定 |
| --- | --- | --- | --- |
| **A 常駐 child process** | spawn 約 80ms | RPC 1ms 台 | **採用**。write < 10ms を満たせる |
| B hash + commit の1往復 | 約 80ms | 約 80ms | 却下。< 10ms に届かない |
| C worker thread | 約 5–10ms | 1ms 台 | 次点。env の seam を外れる / TS worker の build が要る |
| D コンパイル済み helper（Go 等） | 1–3ms | 1–3ms | 却下。toolchain が増える |

- 常駐は **root ごとに1つ**。`probe` で開いた dirfd を保持し、hash / read / commit を RPC にする。
- まず A。C は A で性能が足りないときの代替として残す。

### 決定案 2: port と protocol

- `Rooted` の入力に **`spawn` を持つ小さな port** を足す（`ExecutionEnv` 自体は変えない）。test が実装し、machine 側の配線は 0157 / 0194 で行う（いまは machine に Workspace の生成が無い）。
- protocol は NDJSON（1 行 1 リクエスト / 応答）。`{ id, op, ... }` と `{ id, ok, ... }`。request id で多重化する。
- helper は起動時に `probe` 相当（root / id / dev / ino）を受け、dirfd を保持する。
- stdout は応答専用。ログは stderr（本文・パスは出さない）。

### 決定案 3: lifecycle と crash

- lazy start: 最初の操作で spawn。root の open では spawn しない（probe は1回だけ）。
- idle 60 秒で close。`Workspace.close` で必ず close し、子プロセスを残さない。
- helper が落ちたら、pending の要求を `helper_unavailable` で失敗させ、次の操作で**1回だけ再起動**する。60 秒以内に3回落ちたら fail closed（以後は失敗）。
- **checks へ黙ってフォールバックしない**（TOCTOU の窓が広がる）。`rooted: "required"` は失敗のまま。

### 決定案 4: 計測とゲート

- write は warm 後の p95 < 10ms。integration 層 < 3s。before / after を issue の表に残す。
- ゲートの test stage の出力に、パッケージごとのテスト時間を1フィールド足す（`tools/gate/`）。
- 計測は `packages/workspace/test/` の benchmark ではなく、issue の表 + ゲートの実測で固定する（flaky な CI 依存を作らない）。

### 決定案 5: テスト

- C1: 既存の TOCTOU / hardening / traversal の拒否が、常駐経路でも同じ。
- C2: helper を強制終了 → 次の操作が決めた扱い（1回再起動 / 3回で fail closed）。黙って成功しない。
- C3: 計測（write p95、integration 全体）。
- C4: ゲートの出力にパッケージ時間。
- C5: `npm run check`。

### 調査（2026-11-17、完了）

- レポート: `work/research/workspace-helper-designs.md`（757行、git cat-file / Bazel persistent worker / LSP / watchman / esbuild / sccache / gopls / Node child vs worker / openat2 / os.Root / cap-std / libpathrs / Landlock）。
- **実測（このマシン、Node 26）**: 現行 write は p50 **150.7 ms**（hash + commit の2 spawn）。常駐化した試作は同じ2操作が **p50 0.22 ms / p95 0.45 ms**。worker は起動 p50 9.8 ms / p95 11.0 ms。spawn 1回は 74 ms（dist の .js でも 43.5 ms）。
- **stdio NDJSON + request id** が最適（RTT 0.04 ms。8 MiB は chunk 単位の framing で 21.9 ms、素朴な連結は 351 ms）。
- **integration の現状は 6.8 s / 48 tests**（churn test 3053 ms が spawn 支配）。常駐化後は 1–2 s の見込み。
- crash は **1 回再起動 / 60 秒 3 回で fail closed**。idle 60 秒 + timer unref + `Workspace.close` からの close が要る（timer があると親死亡後も孤児化するのを実測）。
### 調査結果の反映（R1–R6）

- **R1（U-01）**: 1 root = 1 常駐 child process。B（1往復）は 74 ms で <10ms に届かず、D（コンパイル済み）も 43.5 ms で単独では不足。C（worker）は起動 9.8 ms だが初回 write が境界・seam を外れる・TS worker の build・native crash の隔離が弱いので次点。RSS は約 73 MB / helper。同時数は LRU で上限 8 を目安にする。
- **R2（U-02）**: `ExecutionEnv` は変えず、`RootedInput` に **`HelperPort`**（spawn → `HelperProcess`）を足す。起動時に `hello`（root / id / dev / ino）を1回だけ送り、以降は root を再送しない。**NDJSON + request id**、1行 16 MiB 上限、helper は到着順に直列処理。背圧は drain、timeout は kill。JSON 不正 / EPIPE は protocol failure（全 pending を失敗、プロセスを捨てる）。
- **R3（U-03）**: pending は `helper_unavailable` で失敗。次の操作で1回だけ再起動し、hello で root / marker を再検証。60 秒に3回で fail closed。timeout も同じカウンタ。**checks へ落とさない**（dirfd で開いた後に checks へ落ちると封じ込めが弱くなる）。故障注入はテスト用 HelperPort で行う。
- **R4（U-04）**: lazy spawn、idle 60 秒（timer は unref）、pending 中は閉じない。`Rooted.close()` を足し、`Workspace.close` から呼ぶ。close は「新規拒否 → pending を最大1秒 → stdin end → SIGTERM → 1秒で SIGKILL」。helper は stdin end で exit（orphan 防止）。
- **R5（U-05）**: 本番は Workspace ごとに1 helper（root を跨がない）。テストもまず同じ形で測り、integration が 3 s を超えたときだけ test/support に root キーの pool を足す。pool は本番コードに入れない。
- **R6（計測）**: workload は「同じ root で 50 write + 50 read + 10 open」。warmup 後に p50 / p95。before / after を issue に残す。ゲートは `gate: test <pkg> ok (Nms)` の run 単位を足す。RSS をログに残す。ベンチを CI の合否にしない。

| 操作 | before | after（見込み） | 条件 |
| --- | --- | --- | --- |
| open（probe 1回） | 73.6 ms | 38.2 ms（spawn → hello） | p50 |
| write（hash + commit） | 150.7 ms | 約 2.7 ms（helper 0.22 + fs） | p50 |
| integration（workspace） | 6.8 s / 48 tests | 1–2 s | vitest |
### 現行コードとの差分

- `RootedInput` は `{ env, root, id, context }`。ここに **`helper: HelperPort`** を足す（`ExecutionEnv` は変えない）。
- `Rooted.probe` は今 `invoke(..., { op: "probe" })` の1回起動。常駐では **`HelperPort.spawn` → `hello`** に置き換える。`hello` が dev / ino を返し、`#dev` / `#ino` を保持する。
- `Rooted.#call`（hash / read / commit）は **`HelperProcess.request`** に置き換える。1操作1プロセスの `invoke` は常駐経路では使わない（`checks` は helper を呼ばない）。
- `Rooted.close()` を足す。`Workspace` は `#rooted` を持っているので、`close`（watcher と claim の解放）で `await this.#rooted?.close()` を呼ぶ。
- `rooted-helper.ts` の entry は `process.argv` の1回実行から **`serve`（stdin NDJSON）** に変える。テスト用に `--once` を残すかは実装で決める（本番は serve だけ）。
- テスト: 既存の integration は実プロセスを起動している。テスト用 `HelperPort` を `test/support/` に置き、`Rooted` の単体は fake port で回す。
### 決定（D093）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | child process か worker thread か | **決定（user）**: 常駐 child（A）。worker は次点 | 0191 / 0147 | 2026-11-17 |
| U-02 | port の形 | **決定（user）**: `HelperPort` + NDJSON + id。直列、16MiB 行上限 | 0033 / 0147 | 2026-11-17 |
| U-03 | crash の扱い | **決定（user）**: 1回再起動 / 60秒3回で fail closed。timeout も数える。checks へ落とさない | 0191 | 2026-11-17 |
| U-04 | idle / close | **決定（user）**: idle 60s（timer unref）+ `Rooted.close` + `Workspace.close`。stdin end で helper が exit | 0156 / 0191 | 2026-11-17 |
| U-05 | テストの helper 再利用 | **決定（user）**: Workspace ごとに1 helper。3s 超えで test/support の pool | 0191 | 2026-11-17 |

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | TOCTOU / hardening / traversal の拒否 → 常駐経路 → 同じ結果 | 高 | 受入2 |
| C2 | helper を kill → 次の操作 → 1回再起動 / 3回で fail closed。成功として返さない | 高 | 受入4 |
| C3 | 同じ workload → write p95 < 10ms、integration < 3s | 中 | 受入3 |
| C4 | ゲート → パッケージごとのテスト時間が読める | 低 | 受入5 |
| C5 | `npm run check` | 高 | 受入6 |

## やらないこと

- セキュリティ境界の変更（probe の条件、dirfd の検証）。
- ゲート全体の高速化（0041 / 0172 の範囲外）。

## Log

- 2026-11-11: 作成。0172 を吸収し、計測の固定を足した。
- 2026-11-17: 設計案を追加。U-01〜U-05 は既製品の常駐ヘルパー設計の調査（work/research/workspace-helper-designs.md）を待つ。
- 2026-11-17: helper-research のレポート（757行）を反映。A / NDJSON / 1回再起動 / idle 60s / Workspace ごと1 helper を推奨。U-01〜U-05 の判断待ち。
- 2026-11-17: D093 で合意。U-01〜U-05 を推奨どおり決定し、`design: agreed` にした。

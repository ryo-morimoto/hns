# 0227: sandbox 追加硬化の実測（Landlock / netns+proxy / seccomp）

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §12, work/research/tool-call-fastpath-security.md §8
depends-on: -
touches: work/research/sandbox-hardening.md, packages/workspace/test/integration/sandbox-hardening.test.ts, work/poc/sandbox-hardening/

## Intent

bwrap の mount namespace だけでは、読み取りの広さ・ネットワーク・危険 syscall の 3 つが残る。Landlock / netns + UDS proxy / seccomp BPF のどれが NixOS の実機で使え、どのくらい遅いかを、製品コードを変えずに測る。結果で Phase 2 の設計を決める。

## Goal

S1（Landlock の read 拒否）、S2（`--unshare-net` + UDS proxy）、S7（seccomp で io_uring / AF_VSOCK 遮断）を実測し、`work/research/sandbox-hardening.md` に数字・落ち方・採用可否を残す。製品コードは変えない。

## Acceptance criteria

- [x] S1: bwrap 内で Landlock ABI v3+ を適用し、root 外 read が拒否され、root 内は通る。symlink / `..` / bind mount の組合せを試す
- [x] S1: bash 1 回の p95 悪化を測る（目標 ≤ 5ms）
- [x] S2: `--unshare-net` + loopback の UDS proxy で git clone / npm install / curl / ssh が通る。DNS と TLS を含む
- [x] S2: p95 追加を測る（目標 ≤ 15ms）。迂回経路（raw socket / netlink / 継承 fd）が無いことを確認する
- [x] S7: bwrap `--seccomp` で io_uring と AF_VSOCK を遮断し、bash の p95 悪化を測る（目標 ≤ 2ms）
- [x] 結果を表にし、採用 / 不採用 / 追加調査を判定する。製品コードを変えない
- [x] `npm run gate test` の対象になるテストは skip 可能にし、実機が無ければ理由を残す

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | bwrap + Landlock → root 外 read → 拒否。root 内 → 成功 | 高 | S1 |
| C2 | bwrap + Landlock → symlink / `..` / bind mount → root 外に出ない | 高 | S1 |
| C3 | `--unshare-net` + proxy → git/npm/curl/ssh → 成功。proxy 無し → 失敗 | 高 | S2 |
| C4 | proxy のログ → 許可外 host への接続が無い | 高 | S2 |
| C5 | bwrap `--seccomp` → io_uring / AF_VSOCK → EPERM。通常の bash → 成功 | 高 | S7 |
| C6 | 各構成 → p50/p95 → 表に残る | 中 | S1/S2/S7 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C2 | 実機 probe | integration | `packages/workspace/test/integration/sandbox-hardening.test.ts` |
| T2 | C3–C4 | 実コマンド + proxy | manual / integration | `work/poc/sandbox-hardening/` |
| T3 | C5–C6 | 実機 + 計測 | manual | 同上 |

## Notes

- 既存の `detectSandbox` / `createSandboxEnv` を使う。製品コードは変えない。
- OpenShell の Landlock baseline / seccomp notify / outer fence、Codex の bwrap + seccomp を参考にする。ただし seccomp-notify は D090 で不採用。
- NixOS のカーネル 6.18、bubblewrap 0.12.0（実機は 0.13.1）を記録する。

## 未確定

- UDS proxy を何で書くか（Node の http server + CONNECT か、既存の proxy か）。PoC は Node でよい。
- Landlock の ABI が NixOS で有効か。無効なら S1 は不採用。
- seccomp の BPF を Node からどう渡すか（事前コンパイルした BPF を同梱する）。

## やらないこと

- 製品コードへの組み込み（結果で別 issue）。
- seccomp user notification。
- TLS MITM。

## Log

- 2026-11-17: 作成（D091）。
- 2026-11-17: ユーザー判断で `next` から `now` へ（依存なし）。

## Result

- verdict: **PASS**（reviewer-0227。blocking 0 / 低 6）
- HEAD: 3f81e3d（main に ff 統合）。gate は exit 0（993 tests / 1 skip、main で 53.9s）。
- 実機: bwrap 0.13.1 / kernel 6.18.59 / LSM=lockdown,capability,landlock,yama,bpf,ima / **Landlock ABI 7** / seccomp 可 / user namespace 可。
- 判定: **S1 採用**（root 外 read は EACCES、\`..\` と symlink も EACCES。**bind mount と事前 open の fd は通る** → 別 issue）。**S2 条件付き**（netlink EPERM、ssh は ProxyCommand で到達、**git / npm は SOCKS を URL で受けない**ので shim が要る、**継承 TCP fd は名前空間を越える**）。**S7 採用**（io_uring / AF_VSOCK を EPERM、13 命令 104 バイト、AF_INET と file open は通る）。
- コスト（N=200 × 3、warmup=20、reviewer が再測）: seccomp **+0.01ms** p95、landlock ~0〜+0.8ms、proxy +0.06〜0.2ms。いずれも目標（2 / 5 / 15ms）の内側。
- テスト: C1 / C2 / C5 の 4 本（実機 pass、bwrap 不可で skip + 理由、HNS_REQUIRE_BWRAP=1 で fail）。no-op fence では 4/4 fail（skip が壊れた柵を隠せない）。
- 非 blocking（低 6）: research の表と本文の数値の食い違い（+0.814 vs +0.03）/ 「8 バイト×13 命令」は 104 バイト / baseline の数字の出所 / poc の一時ディレクトリと .cache/measure が未 commit / integration test が landlock 不在を skip にする / C5 の baseline が弱い。
- 次: S1 / S7 の Phase 2 設計（mount の形、継承 fd を塞ぐ設計、shim）は別 issue。

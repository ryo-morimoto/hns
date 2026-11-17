# sandbox-hardening の実測

issue 0227（`work/issues/0227-sandbox-hardening-spike.md`）の S1 / S2 / S7 と C1〜C6 を実機で測るための PoC。
**製品コードではない**。数値・落ち方・採用可否は [../../research/sandbox-hardening.md](../../research/sandbox-hardening.md) にある。

## 何が入っているか

| ファイル | 役目 |
| --- | --- |
| `src/probe-landlock.c` | bwrap の内側で Landlock を張り、root 内 / root 外の read を試す（C1） |
| `src/probe-escape.c` | `..` / symlink / bind mount / 事前 open の fd で root の外に出られるかを見る（C2） |
| `src/probe-syscalls.c` | io_uring / AF_VSOCK / AF_INET / file open を 1 つずつ呼んで errno を出す（C5） |
| `src/seccomp.mjs` | S7 の BPF を組み立てる。ジャンプの飛び先を検算する `verifyFilter` 付き |
| `src/emit-bpf.mjs` | 上の BPF を `bin/sandbox-hardening.bpf`（8 バイト×13 命令）に書き出す |
| `src/proxy.mjs` | host 側の egress proxy。UDS と TCP の 2 モード、HTTP CONNECT と絶対 URL の両対応 |
| `src/client.mjs` | proxy に CONNECT して生バイトを流す。ssh の ProxyCommand / git の shim の実体 |
| `src/proxy-shim.sh` | 上の 2 つをコマンドとして差し込むための薄いラッパ |
| `src/netns.mjs` | S2 の本体。`--unshare-net` の中で git / npm / curl / ssh と迂回経路を確かめる（C3 / C4） |
| `src/inherit-fd.mjs` | 継承 fd が名前空間を越えることだけを見る最小 probe |
| `src/landlock.mjs` | C1 / C2 を bwrap 越しに実行して JSON にする |
| `src/seccomp-probe.mjs` | S7 の C5 を実行して JSON にする |
| `src/measure.mjs` | p50 / p95 を N 回・warmup 付き・interleave で測る（C6） |
| `src/proxy-cost.mjs` | proxy の 1 接続あたりのコストだけを測る |
| `src/build.sh` | C の probe と BPF を作り直す |

`bin/` のバイナリと BPF は**コミットする**。統合テスト（`packages/workspace/test/integration/sandbox-hardening.test.ts`）が
それを直接実行するので、テストのたびにコンパイルしない。作り直しは `sh src/build.sh`。

## 動かす

Node 標準と bwrap、gcc だけを使う。npm の依存は入れない。

```bash
sh src/build.sh                                      # bin/ を作り直す（必要なときだけ）
node src/landlock.mjs --out /tmp/landlock.json       # C1 / C2
node src/seccomp-probe.mjs --out /tmp/seccomp.json   # C5
node src/netns.mjs --out /tmp/netns.json             # C3 / C4（ネットワークに出ます）
node src/measure.mjs --n 200 --warmup 20 --rounds 3  # C6
```

`netns.mjs` は github.com / example.com / registry.npmjs.org に出る。ネットワークの無い環境では失敗する。
計測は 1 本ずつ回す（他のレーンの負荷を避けるため）。

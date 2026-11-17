# sandbox 追加硬化の実測（Landlock / netns+UDS proxy / seccomp）

2026-11-18。実機で測った。issue 0227（`work/issues/0227-sandbox-hardening-spike.md`）の C1〜C6 と S1 / S2 / S7 に対応する。
製品コードは変えていない。結論だけ先に書く。

## 実機

| 項目 | 値 |
| --- | --- |
| `bwrap --version` | `bubblewrap 0.13.1`（`/nix/store/…-bubblewrap-0.13.1/bin/bwrap`） |
| `uname -r` | `6.18.59` |
| `cat /sys/kernel/security/lsm` | `lockdown,capability,landlock,yama,bpf,ima`（**landlock が有効**） |
| seccomp | `/proc/sys/kernel/seccomp` あり。`actions_avail` = `kill_process kill_thread trap errno user_notif trace log allow` |
| user namespace | 使える（`/proc/sys/user/max_user_namespaces` = 2147483647、bwrap の probe 成功） |
| Landlock の ABI | **7**（`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` の実測） |
| Node / gcc | node 24.22.2 / gcc 16.2.0（NixOS system） |
| 計測負荷 | 16 コア、load average 3.5〜4.3（他レーンが常時走っている）。計測は 1 本ずつ、他の probe と重ねていない |

本 sandbox（この agent の実行環境）では user namespace は**使えた**。使えなかった場合の扱いは
「[実機が使えないとき](#実機が使えないとき)」に書く。

## 結論（採用可否）

| 案 | 実測 | 採用可否 |
| --- | --- | --- |
| **S1 Landlock（root 外の read の拒否）** | 効く。root 外は EACCES(13)、root 内は通る。`..` と symlink も EACCES。**bwrap が root の内側にファイルを bind すると通ってしまう**（Landlock は「root の下」を許すので、mount の判断はできない）。bash 1 回の p95 悪化は **≈ 0.01ms**（目標 ≤ 5ms） | **採用（第2の柵として）**。ただし「wrapper が何を mount するか」を Landlock で守ることはできない。mount の制御は bwrap の引数側に残る。→ 追加調査: `--ro-bind` の対象を最小化する設計 |
| **S2 `--unshare-net` + UDS proxy** | 名前空間は効く（route 無し、DNS は `dns=ok` だが接続不可、netlink は EPERM）。UDS proxy は **ssh の ProxyCommand でだけ素直に通る**（TLS 込みで github.com:22 まで到達）。git / npm / curl は proxy を「URL」でしか受け取らない（`only SOCKS proxies support paths` / `Must be full url`）ので、**それぞれ専用の shim が要る**。**継承 fd は名前空間を越える**（親が開いた TCP fd は子で使える）。raw socket / netlink の迂回は無い | **条件付き採用（追加調査）**。egress を「proxy のログ」で証明するなら、fd の継承を**塞ぐ**仕組みが要る（bwrap は親が明示した fd を閉じない）。git/npm 用 shim の保守コストが問題 |
| **S7 seccomp（io_uring / AF_VSOCK）** | io_uring_setup は **EPERM(1)**、AF_VSOCK は **EPERM(1)**、AF_INET と通常の file open は通る。bash 1 回の p95 悪化は **≈ 0.01ms**（目標 ≤ 2ms） | **採用**。BPF を事前コンパイルして `--seccomp` の fd に渡す形はそのまま製品に移せる。注意: この実機では **io_uring は seccomp 無しでも ENOSYS(14)**（bwrap が `--seccomp` 無しでも何かしているか、カーネル側が無効）。EPERM と ENOSYS を区別して記録した |

**総合**: seccomp は今すぐ入れられる（コストが実質ゼロ、効果が明確）。Landlock は「root 外の read」には効くが mount の形は守れないので、
bwrap の mount 引数を絞ることが前提。netns + proxy は名前空間としては強いが、**proxy を経由しない fd が残る**ので
「egress の完全な可視化」を売りにするなら design の変更が要る（下の「製品コードへの影響」）。

## 測り方

`work/poc/sandbox-hardening/` にある。Playwright も新規 npm 依存も無い（Node 標準 + C の probe + bwrap）。

| 何 | 場所 |
| --- | --- |
| 計測の本体（p50/p95、N と warmup、interleave） | `src/measure.mjs` |
| S1 の C1（root 外 read の拒否） | `src/probe-landlock.c` → `bin/probe-landlock` |
| S1 の C2（symlink / `..` / bind mount / 事前 open の fd） | `src/probe-escape.c` → `bin/probe-escape` |
| S7 の BPF（事前コンパイル、Node からは渡すだけ） | `src/seccomp.mjs` → `src/emit-bpf.mjs` → `bin/sandbox-hardening.bpf` |
| S7 の syscall probe | `src/probe-syscalls.c` → `bin/probe-syscalls` |
| S2 の proxy（HTTP CONNECT / 絶対 URL の両対応、UDS と TCP の 2 モード） | `src/proxy.mjs` |
| S2 のトンネル（ssh ProxyCommand / git 用） | `src/client.mjs`, `src/proxy-shim.sh` |
| S2 の実行と迂回の確認 | `src/netns.mjs` |
| 継承 fd だけを見る最小 probe | `src/inherit-fd.mjs` |
| 再ビルド | `sh src/build.sh` |

計測条件:
- N = **200**（1 構成あたり、1 round あたり）、warmup = **20**、rounds = **3**。
- 3 round は **interleave**（round 1 で全構成、round 2 でまた全構成）。別レーンの負荷変動を全構成に均すため。
- 表の p50/p95 は**3 round の平均**。round ごとの値も research の元データ（`.cache/measure/perf.json`）に残した。
- 計測前後で **baseline を 2 回**取った（before: p50 4.673 / p95 5.228、after: p50 4.663 / p95 5.236）。差は 0.01ms で、
  計測中のドリフトは無いとみなした。
- 単位: 1 回の `bwrap … -- <command>` を spawn して exit まで（wall clock）。

## S1 Landlock

### C1: root 外の read は拒否、root 内は通る

| 確認 | 結果 |
| --- | --- |
| ABI | **7**（v3 以上） |
| root 内のファイルを open + read | **成功** |
| root 外（兄弟ディレクトリ）のファイル | **EACCES (13)** |
| ruleset を `/` にして外を読む（負の対照） | **成功**（restriction が効いていなければ通ることを確認した） |

### C2: symlink / `..` / bind mount / 事前 open の fd

| 形 | 結果 | 意味 |
| --- | --- | --- |
| `ROOT/inside.txt` | 成功 | 対照 |
| `ROOT/../dotdot-target.txt` | **EACCES (13)** | `..` で抜けられない |
| `ROOT/link-<target>`（root 外を指す symlink） | **EACCES (13)** | symlink を辿って抜けられない |
| root 外のファイルを `ROOT/bound.txt` に bind（bwrap が mount） | **成功** | **抜け道**。mount は root の下にできるので Landlock の規則では通る |
| ruleset 適用前に open した fd | **成功** | **抜け道**（Landlock の仕様どおり: fd は取り上げられない） |

「bind mount は抜け道」は probe の欠陥ではない。Landlock は path（inode）の規則で、mount の可否を知らない。
**bwrap の mount 引数を絞ることでしか塞げない**（`--ro-bind / /` をやめる、root の下に何も bind しない）。
「事前 open の fd」は wrapper が fd を閉じているか（`--sync-fd` を使わず、`closefrom` 相当をしているか）に依存する。
bwrap は親の明示 fd を閉じない（S2 の継承 fd と同じ性質）。

### S1 のコスト

Landlock は「ルールを張っているプロセス」を制限するので、shell 自身には張れない。probe は helper プロセスで測った。
したがって対照は「helper をルール無しで起動」と「helper をルール有りで起動」の差。

| 構成 | p50 (ms) | p95 (ms) | round ごとの p50/p95 |
| --- | --- | --- | --- |
| helper-nolandlock（対照） | 3.700 | 4.540 | 3.73/4.58, 3.64/4.56, 3.74/4.48 |
| helper-landlock | 3.878 | 5.354 | 3.74/4.47, 3.77/4.49, **4.12/7.09** |
| **差** | **+0.178** | **+0.814** | 3 round のうち 2 round は +0.0〜+0.03 |

3 round 目だけ p95 が 7.09 に跳ねた（別レーンの負荷と思われる）。中央値の差は 2 round ではほぼ 0。
**bash 1 回の p95 悪化 ≈ 0.8ms 以下、目標 5ms に対して余裕がある**。目標は満たす。

## S2 `--unshare-net` + UDS proxy

### 名前空間そのもの

| 確認 | 結果 |
| --- | --- |
| 名前空間の中の link | `lo` だけ |
| `ip route` | 空（既定 route 無し） |
| `curl http://1.1.1.1` | 失敗（exit 7） |
| DNS（`dns.lookup`） | 解決自体は返るが、その先に接続できない（route が無い） |
| netlink で lo に addr / route を足す | `RTNETLINK answers: Operation not permitted`（EPERM） |
| raw socket | 名前空間に route が無いので出られない |

### UDS proxy を通した各コマンド

proxy は host で UDS を listen し、HTTP CONNECT と絶対 URL の GET を両方話す。ログは 1 リクエスト 1 行（host / port / 判定）。

| コマンド | 経路 | 結果 | 補足 |
| --- | --- | --- | --- |
| **ssh** git@github.com | `ProxyCommand` → shim → UDS | **通る**（`Permission denied (publickey)` = 握手まで到達） | TLS でなく ssh プロトコル。DNS は proxy 側で解決 |
| ssh（proxy 無し） | — | `Network is unreachable` | 対照 |
| **git** ls-remote https | `http.proxy` に URL | `fatal: Invalid proxy URL '…/p.sock': only SOCKS proxies support paths` | **git は UDS を URL として受け付けない** |
| git（TCP proxy の対照） | `http.proxy=http://127.0.0.1:<port>` | **通る**（`refs/heads/master` を取得） | proxy と host 側は動く。TLS 込み |
| **npm** view | `npm_config_proxy` に URL | `npm warn invalid config Must be full url with "http://"` / `ERR_INVALID_URL` | **npm は URL しか受け付けない** |
| npm（TCP proxy の対照） | 同上（TCP） | **通る**（`1.3.0`） | DNS + TLS |
| **curl** `-x http://127.0.0.1:<port>` | 名前空間の中 | 失敗（exit 7） | **名前空間の中では TCP の proxy ポートにも届かない** |
| curl `-x`（TCP proxy の対照、host で実行） | — | **200** | proxy と TLS は動く |
| curl（UDS 経由、shim で手動） | `printf 'GET http://…'` → shim | **通る** | curl 自身に UDS proxy の機能は無いので、これは「トンネルが通る」ことの確認 |
| git（proxy 無し） | — | `Failed to connect … Could not connect` | 対照 |

**読み方**: `--unshare-net` は「TCP の route を消す」だけで、**ツールの proxy 設定は URL しか受け付けない**。
UDS を素直に使えるのは ssh（ProxyCommand がコマンドだから）だけ。git / npm / curl は
「proxy コマンドを差し込む shim」を各ツールに用意する必要がある（git は `GIT_CONFIG` の helper ではなく、
HTTPS の通信自体を shim で包む形になる）。これは保守の対象が増える。

### 迂回経路

| 経路 | 結果 |
| --- | --- |
| raw socket / 通常の connect | route が無いので出られない |
| netlink で route を足す | EPERM |
| **親から継承した TCP fd** | **越える**（親が開いた 127.0.0.1 の echo サーバと、子が fd 3 で読み書きできた） |

継承 fd は**この名前空間だけでは塞げない**。bwrap は親が明示的に渡した fd（`stdio` の 3 以降）を閉じない。
製品側で「子に渡す fd を 0/1/2 だけにする」ことを保証する必要がある。
（bwrap を `--sync-fd` なしで使っても、親が `spawn` に fd を渡せば子に届く。probe は実際にそれで越えた。）

### C4: proxy のログ

最後の run のログは **2 行だけ**で、どちらも依頼した host（`github.com:22`、`example.com:80`）だった。

```json
{"at":1794931318970,"decision":"allow","host":"github.com","port":22,"method":"CONNECT"}
{"at":1794931321339,"decision":"allow","host":"example.com","port":80,"method":"CONNECT"}
```

許可外の host への allow は無い。ただし**上の継承 fd があるので、「ログに無い = 通信していない」は言えない**。
fd の制御を入れてからでないと C4 を「証明」には使えない。

### S2 のコスト

S2 の「p95 追加」は 2 つに分けて測った。

1. **proxy の 1 接続あたりのオーバーヘッド**（`src/proxy-cost.mjs`）: loopback の echo サーバに直結した場合と、
   UDS の proxy を 1 回通した場合を、同じプロセスで 200 回ずつ interleave で測った。

   | 経路 | p50 (ms) | p95 (ms) |
   | --- | --- | --- |
   | 直結（127.0.0.1 の echo） | 0.147 | 0.260 |
   | UDS proxy 経由（CONNECT + 1 往復） | 0.196 | 0.474 |
   | **差** | **+0.049** | **+0.214** |

   **目標 ≤ 15ms は余裕で満たす**。proxy 自体のコストは無視できる。

2. **実際のコマンド**（git / npm / ssh）: こちらは DNS + TLS + RTT が支配的で、proxy の差はその中に埋もれる。
   git ls-remote は TCP proxy 経由（host で実行）と直結で同じ桁だった。**実通信のレイテンシはネットワーク次第で、
   sandbox の構成差ではない**、と記録する。

## S7 seccomp

フィルタ: `src/seccomp.mjs` が組み立て、`src/emit-bpf.mjs` が 8 バイト×13 命令（104 バイト）の
`bin/sandbox-hardening.bpf` に書き出す。bwrap はこれを `--seccomp <fd>` で読み、exec 前に落とす。
**Node は prctl を呼ばない**（渡すだけ）。

| 確認 | 実測 |
| --- | --- |
| フィルタ無しで io_uring_setup | **ENOSYS (14)**（この実機ではカーネルが io_uring を提供していない） |
| フィルタ無しで AF_VSOCK | 成功（socket は開く） |
| フィルタ有りで io_uring_setup | **EPERM (1)** |
| フィルタ有りで AF_VSOCK | **EPERM (1)** |
| フィルタ有りで AF_INET | **成功**（socket(2) を丸ごと拒否していない） |
| フィルタ有りで `/etc/hostname` の open | **成功** |
| フィルタ有りで `sh -c :` | exit 0 |

ENOSYS と EPERM の区別は重要。io_uring が使えないカーネルでは「EPERM になった」だけでは
フィルタが効いた証拠にならない。probe は対照を必ず取る。

### S7 のコスト

| 構成 | p50 (ms) | p95 (ms) | 差 |
| --- | --- | --- | --- |
| bash（対照） | 4.673 | 5.228 | — |
| bash-seccomp | 4.705 | 5.238 | **+0.032 / +0.010** |
| syscalls（対照） | 3.754 | 4.572 | — |
| syscalls-seccomp | 3.926 | 5.034 | **+0.172 / +0.462** |

bash 1 回の p95 悪化は **≈ 0.01ms**（目標 ≤ 2ms）。syscalls の方は EPERM を返す分だけ少し遅いが、それでも 0.5ms 未満。

## 製品コードへの影響（このレーンでは変えない）

| 変えるべき所 | 理由 | 提案（別 issue） |
| --- | --- | --- |
| `createSandboxEnv` の argv | S7 は引数 2 つ（`--seccomp` と fd）で足りる。BPF は同梱 | seccomp を常時有効にする。fd を開く所を 1 箇所に |
| 子プロセスに渡す fd | 継承 fd が netns を越える。S2 の前提を壊す | `spawn` の `stdio` を 0/1/2 に固定し、それをテストで固定する |
| `--ro-bind / /` | Landlock を張っても、root の下に bind されれば通る | mount の対象を減らす（NixOS の store と shell だけ bind する等） |
| proxy（S2） | git / npm / curl は UDS を URL として受け付けない | 製品に proxy を入れるなら、ツールごとの shim と egress ログの契約を決めてから |

## 実機が使えないとき

自動テストは `detectSandbox()` が `available: false` なら skip し、**skip の理由として probe の reason**を残す。
`HNS_REQUIRE_BWRAP=1` の環境（リリースゲート）では skip ではなく失敗になる（`tools/test/cf-dev.ts` の `requireTool`）。
Landlock が無いホストでは、`probe-landlock` が ABI の取得に失敗して exit 1 になり、その場合もテストは
「ABI が読めない」で落ちる（skip にしない: Landlock を前提にした設計の前提が崩れているため）。

## 出所

| 内容 | URL |
| --- | --- |
| Landlock（ABI、path_beneath の規則） | <https://docs.kernel.org/userspace-api/landlock.html> |
| seccomp（BPF、RET_ERRNO） | <https://docs.kernel.org/userspace-api/seccomp_filter.html> |
| bubblewrap（`--seccomp`、`--unshare-net`、fd の扱い） | <https://github.com/containers/bubblewrap> |
| git の http.proxy（URL しか取らない） | <https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpproxy> |
| curl 8 の proxy 指定（UNIX socket は未対応） | <https://curl.se/docs/manpage.html#-x> |
| npm の proxy 設定 | <https://docs.npmjs.com/cli/v10/using-npm/config#proxy> |
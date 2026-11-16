# workspace helper の設計調査（0191 / 2026-11-17）

0191（workspace の実行性能）の判断材料として、常駐ヘルパーの既製品設計・Node の実行基盤・パス封じ込め・失敗時の運用を調べた。コードは変更していない。実測はこのマシン（Linux 6.18.59 / AMD Ryzen 9 7940HS / 16 cores / 60.6 GB）で行った。

## 0. 結論（0191 の判断に効く 5 点）

1. **A（1 root = 1 常駐 child process）を採る。** 現行の write は hash と commit で 2 回 spawn し、実測 p50 **150.7 ms**（issue の 154.6 ms と一致）。常駐化すると同じ 2 操作が **p50 0.22 ms / p95 0.45 ms** になる。journal の fsync を含めても write は数 ms に収まる見込みで、目標 write < 10 ms を満たせる。
2. **B（hash + commit の 1 往復化）単独では不足。** spawn 1 回が helper の起動込みで p50 74 ms、dist の JS でも 43.5 ms。1 往復にしても 10 ms に届かない。B は A の後で RPC を 1 回減らす最適化としてのみ意味がある（0.1 ms 程度）。
3. **C（worker thread）は次点。** 起動 p50 9.8 ms / p95 11.0 ms、RTT 0.02 ms、RSS +12 MB。性能は魅力だが、初回 write が 10 ms 境界、ExecutionEnv の seam を外れる、TS worker のビルドが要る、native crash はプロセスごと落ちる、という代償がある。A で足りない場合の代替に残す。
4. **D（コンパイル済み helper）は今は不要。** Node 26 の .ts helper は 74.5 ms、dist の .js は 43.5 ms。常駐化すれば起動は初回だけなので、D の効果は probe / 再起動の 1 回に限られる。openat2 や renameat2 が要る段階で再検討する。
5. **プロトコルは stdio の NDJSON + request id。** RTT は stdio 0.04 ms / IPC 0.03 ms で同等。8 MiB の本文は fair な実装で stdio 21.9 ms / IPC 27.0 ms。stdio は言語非依存で、git / LSP / watchman / esbuild / sccache と同じ形。process.send は Node 専用の最適化として保留する。**実装上の注意**: 素朴な文字列連結で 8 MiB を受けると 351 ms かかった。フレーミングはチャンク単位で行う。

## 1. 調査環境と再現方法

### 1.1 環境

| 項目 | 値 |
| --- | --- |
| kernel | 6.18.59 |
| CPU | AMD Ryzen 9 7940HS w/ Radeon 780M Graphics（16 cores） |
| memory | 60.6 GB |
| repo の Node | flake.nix が nodejs_26 を pin（[flake.nix](../../flake.nix)） |
| 実測に使った Node | v26.13.0（/nix/store/ywwchijlngjj756gqp3izz8xw6q8cca2-nodejs-26.13.0/bin/node） |
| 比較用 Node | v24.22.2（/run/current-system/sw/bin/node） |

nix develop はこのセッションの sandbox では動かなかった（~/.cache/nix が read-only で fetcher lock を作れない）。flake が pin するのと同じ Node 26.13.0 を store から直接使った。したがって数値は「Node 26.13.0 / 本機」の実測であり、CI の数値ではない。

### 1.2 測り方

- 各フェーズ 15 回（RTT は 20 回、big は 10 回）で、最初の 2–3 回を warmup として捨てた。p50 / p95 / min / max を出した。
- spawn は spawn(process.execPath, ["-e", ""]) の exit まで。helper probe は実際の [rooted-helper.ts](../../packages/workspace/src/rooted-helper.ts) を probe で起動し、exit まで。
- worker は new Worker(code, { eval: true }) の ready message まで。RTT は ready 後の postMessage 往復。
- stdio は子の stdin に NDJSON を 1 行書き、stdout の 1 行を待つ。IPC は spawn(..., { stdio: ["ignore","ignore","ignore","ipc"] }) と process.send。
- 実測スクリプトは repo の外（/tmp）に置き、repo には何も残していない。

### 1.3 現行テストの基準値（このマシンでの再測）

~~~text
$ node node_modules/vitest/vitest.mjs run --project workspace-integration --reporter=verbose
Test Files  8 passed (8)
     Tests  48 passed (48)
  Duration  6.80s (tests 94%, transform 4%, import 2%)
real 0m7.225s
~~~

issue の 12.5 s は別環境・別時点の値。このマシンでは 6.8 s。内訳で目立つのは「repeated writes while the parent is swapped stay inside」の **3053 ms** で、これは 21 write × 2 spawn × 約 74 ms = 約 3.1 s とほぼ一致する。テスト時間の大半が helper の起動であることの直接証拠。

## 2. 既製品のプロトコルとライフサイクル

### 2.1 git cat-file --batch / --batch-check

**意図**: 1 プロセスで多数の object を引く。git rev-parse を毎回起動する代わりに、stdin から object 名を読み、stdout に連続して返す。

**protocol**（[git-cat-file(1)](https://git-scm.com/docs/git-cat-file)）
- --batch / --batch-check は stdin から 1 行 1 object を読む。応答は入力順（"in the same order as they have been read"）。
- 既定の情報形式は %(objectname) %(objecttype) %(objectsize)。--batch は情報の後に **object の内容（objectsize バイト）と改行** を続ける。
- --batch-command は info / contents / remote-object-info を 1 行ずつ受ける。-Z は入力を NUL 区切りにする。
- --buffer は「各 object ごとに flush せず、通常の stdio buffering にする。大量の object ではこちらがずっと効率的」。対話的に 1 件ずつ読むときは既定の flush が必要、というトレードオフが明記されている。
- --unordered は --batch-all-objects のときだけ、内容アクセスに有利な順で出す（速くなることがある）。SIGPIPE / EOF で終了。

**多重化**: なし。request id もない。応答は入力順で、1 本のパイプラインとして直列に処理する。git は「1 プロセス・1 ストリーム・順序」で十分という判断。

**cancel / idle**: なし。stdin が閉じる（EOF）か、呼び出し側が kill したら終了。常駐 daemon ではない。

**crash**: 呼び出し側が次の object 取得で新しいプロセスを起動する。git 側に再起動ポリシーはない。

**性能**: 公式の数値はない。--buffer が「much more efficient」、--unordered が「faster output」とだけ文書化されている。プロセス起動を 1 回に amortize する設計で、hns の「1 root = 1 helper」に一番近い。

### 2.2 Bazel persistent worker / multiplex worker

**意図**: コンパイラの起動・JIT warm-up・AST キャッシュを action 間で共有する。公式には「start-up overhead を減らし、JIT を進め、AST などをキャッシュする」([Persistent Workers](https://bazel.build/remote/persistent))。

**protocol**（[worker_protocol.proto](https://github.com/bazelbuild/bazel/blob/master/src/main/protobuf/worker_protocol.proto)、[Creating Persistent Workers](https://bazel.build/remote/creating)）
- ワーカーは起動引数に --persistent_worker を受け、それがあるときだけ常駐する。なければ 1 回のコンパイルをして終了する（one-shot との互換）。
- stdin から WorkRequest を読み、stdout に WorkResponse だけを書く。ログは stderr。
- protobuf は **varint の長さプレフィックス**（MessageLite.writeDelimitedTo 相当）。JSON プロトコルはサイズプレフィックスなしの 1 行 JSON。
- WorkRequest: arguments（argv）、inputs（path + digest。強制ではない）、request_id（0 は singleplex、>0 は multiplex）、cancel（実験的）、verbosity、sandbox_dir（multiplex sandboxing 用）。
- 「1 つのワーカーは request_id 0 の要求だけ、または >0 の要求だけを受ける」という不変条件がある。cancel は同じ request_id を付けて送る。
- WorkResponse は request_id をそのまま返す。multiplex では応答の書き込みを atomic に行い、メッセージが重ならないようにする。

**多重化**: Bazel サーバ側に WorkerProxy と WorkerMultiplexer を置き、1 ワーカープロセスへ request_id 付きで要求を流す。応答の request_id で元の Proxy に戻す。multiplex を使うかはルールの宣言（supports-multiplex-workers）で決まる。--worker_multiplex の既定は true で、機能自体は許可されている。--worker_max_multiplex_instances で並列数を制限する。([Multiplex Workers](https://bazel.build/remote/multiplex))

**cancel**: cancel: true の WorkRequest。--experimental_worker_cancellation（既定 false）が必要。ワーカーは協調的に中断する。Bazel 側は InterruptedException のとき、speculating でなければ worker を invalidate して閉じる（[WorkerSpawnRunner.java](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/worker/WorkerSpawnRunner.java)）。

**idle / 終了**: ビルドをまたいで残るのが既定。ワーカープロトコルに shutdown メッセージはない。終了は stdin の EOF、Bazel の kill、--worker_quit_after_build（主にデバッグ用）のいずれか。Bazel サーバが終了すると stdin が閉じ、ワーカーは終了する。ワーカーは WorkerKey（mnemonic + 起動フラグ + 環境）ごとに最大 worker_max_instances（既定 4）。ワーカーの cwd は /bazel-workers 配下の専用ディレクトリで、chroot はされない。

**crash**: 落ちたワーカーは invalidate され、次の action で再 spawn される。action 自体の再試行は実行戦略（worker,local の fallback など）に従う。ワーカーの stderr は bazel-workers/worker-*.log に残る。

**性能（公表値）**: Java のビルドが **2–4 倍**、Bazel 自身のビルドが約 **2.5 倍**。クリーンビルドでは 2 ワーカーが最速で、1 ワーカー比 +14%。インクリメンタルではさらに効き、定数変更の例で 3 倍、よく使う定数の変更で 6 倍。([Persistent Workers](https://bazel.build/remote/persistent))

**hns への示唆**: 「one-shot 互換のフラグ」「request_id 付きの多重化」「cancel は実験的」「ビルド終了時に落とせる」「ワーカーごとの専用 cwd」はそのまま参考になる。ただし hns の操作はコンパイルより短く、並列化の利益は小さい。id は crash/timeout の対応付けに使い、処理は直列でよい。

### 2.3 LSP（Language Server Protocol）

**意図**: エディタと言語サーバを分離し、サーバをワークスペースごとに常駐させる。クライアントがライフサイクルを持つ。

**protocol**（[LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)）
- JSON-RPC over stdio。ヘッダは Content-Length: <bytes> が必須で、CRLF で区切る。本文は JSON。
- 最初の要求は initialize。それ以外の要求が先に来たら error code -32002、通知は exit 以外 drop。initialize への応答前は、クライアントもサーバも追加の要求・通知を送ってはいけない。([initialize.md](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/general/initialize.md))
- initialize の processId が null でなく、親が死んだらサーバは終了するべき。
- 終了は 2 段階。shutdown 要求（応答を返す。以降の要求は InvalidRequest）→ exit 通知。shutdown を受けていれば exit code 0、受けていなければ 1。([shutdown.md](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_includes/messages/3.17/shutdown.md) / [exit.md](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_includes/messages/3.17/exit.md))
- 仕様は「サーバのライフサイクルはクライアントが管理する。いつプロセスを起動し、いつ shutdown するかはクライアントが決める」と明記する。

**多重化**: JSON-RPC の id で要求と応答を対応付ける。サーバは並列に処理してもよい。$/cancelRequest は通知で、キャンセルされた要求も必ず応答を返さなければならない（JSON-RPC の要請）。キャンセル時の error code は RequestCancelled が推奨。([specification.md](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md))

**cancel**: $/cancelRequest。協調的。サーバが単一スレッドで応答できない場合もある、と仕様が認めている。

**idle**: なし。エディタがワークスペースを閉じるまで常駐する。クライアントが shutdown → exit で落とす。

**crash / restart**: 仕様に再起動ポリシーはない。クライアントの実装が決める。vscode-languageclient は connectionOptions.maxRestartCount と DefaultErrorHandler / CloseAction.Restart を持ち、接続が閉じたときに再起動するか決める（[client.ts](https://github.com/microsoft/vscode-languageserver-node/blob/main/client/src/common/client.ts)）。既定値の数値は本調査では確認していない。

**性能**: 公式の数値はない。常駐の目的は「ワークスペースの解析状態を保持し、毎回の再インデックスを避ける」こと。

### 2.4 watchman

**意図**: ユーザーごとに 1 つの常駐 daemon がファイル変更を監視し、クライアントは Unix socket で subscribe する。

**protocol**（[Socket Interface](https://meta.github.io/watchman/docs/socket-interface)）
- 「watchman service はユーザーごとに 1 つの long-lived process」。クライアントは Unix domain socket に接続する。socket の場所は watchman get-sockname か $WATCHMAN_SOCK。
- PDU は JSON（1 行の compact JSON、改行で終端）または BSER。要求は JSON 配列、応答は JSON オブジェクト。subscribe と log-level はサーバから一方的に PDU を送る。
- subscribe は接続が閉じると購読が暗黙に削除される。unsubscribe コマンドもある。([subscribe](https://meta.github.io/watchman/docs/cmd/subscribe))
- watch-project は候補ディレクトリを **realpath(3)** で解決してから root を探す。root_files（.git など）でプロジェクト root を決める。([watch-project](https://meta.github.io/watchman/docs/cmd/watch-project))
- file query の glob は symlink を follow しない。since は symlink の target を考慮しない。([file-query](https://meta.github.io/watchman/docs/file-query))

**多重化**: 1 接続 1 要求・応答が基本。subscribe だけはサーバ → クライアントの非同期ストリーム。要求 id はない（接続内の順序で対応）。

**cancel**: 明示の cancel はない。購読は unsubscribe か接続 close で止める。クエリは短命。

**idle / 終了**: daemon はユーザーごとに長期常駐。watch 単位では idle_reap_age_seconds（既定 **432000 秒 = 5 日**）で、コマンドも trigger も subscription もない watch が reap される。([config](https://meta.github.io/watchman/docs/config)) 明示終了は watchman shutdown-server。([shutdown-server](https://meta.github.io/watchman/docs/cmd/shutdown-server))

**crash / 復帰**: inotify の overflow（IN_Q_OVERFLOW）を検出すると **recrawl** してディスクと再同期する。recrawl は「watchman がファイルシステムの状態との同期を失ったと判断したときの回復動作」で、inotify の上限が小さい Linux でよく起きる。([troubleshooting](https://meta.github.io/watchman/docs/troubleshooting)) daemon が落ちた場合は、次のクライアントが新しい daemon を spawn する（watchman バイナリが面倒を見る）。

**性能**: 公式の数値はない。watch の数と inotify の上限が実効性能を決める。

### 2.5 esbuild service

**意図**: JS API が Go 製の esbuild バイナリを子プロセスとして起動し、ビルド要求を何度も送る。起動と Go ランタイムの初期化を amortize する。増分 rebuild は前回のファイル内容や AST をキャッシュする。

**protocol**（[service.go](https://github.com/evanw/esbuild/blob/main/cmd/esbuild/service.go)、[stdio_protocol.go](https://github.com/evanw/esbuild/blob/main/cmd/esbuild/stdio_protocol.go)）
- 「stdin/stdout 上の単純な long-running service」。各要求は文字列の配列、各応答は文字列 → byte slice の map。**すべての値は 32-bit little-endian の長さプレフィックス**。
- 独自のバイナリ JSON（プリミティブ + ネストした配列/map + byte array）。要求には id があり、応答と対応付ける。service は nextRequestID と callbacks map を持つ。要求を受けたら必ず応答を返す（相手がブロックしている）。
- JS 側は service を共有できる。stop() で service を止める。service が死ぬと「The service was stopped」で失敗する。

**多重化**: あり（id + callbacks）。ただし rebuild はキーごとに直列化される（activeBuilds）。

**cancel**: cancel 要求で進行中の rebuild を止める。service 側は didGetCancel を持つ。([service.go](https://github.com/evanw/esbuild/blob/main/cmd/esbuild/service.go))

**idle**: 明示の idle 終了はない。JS API の stop() かプロセス終了まで残る。CLI は 1 回で終わる。

**crash**: 自動再起動はしない。呼び出し側が新しい service を起動する。service が落ちたときの応答は「service was stopped」エラー。

**性能（公表値）**: three.js を 10 コピー production bundle して、esbuild **0.39 s**、parcel 2 **14.91 s**、rollup 4 + terser **34.10 s**、webpack 5 **41.21 s**。サイト全体で「10–100x faster」を掲げる。([esbuild](https://esbuild.github.io/))

### 2.6 sccache

**意図**: コンパイラのキャッシュ。短命の CLI（コンパイラ 1 回ごと）と、長命の daemon（キャッシュと統計を持つ）に分かれる。CLI はコンパイル要求を daemon に転送し、daemon が cache lookup / compile / store を行う。

**protocol**（[Architecture](https://github.com/mozilla/sccache/blob/main/docs/Architecture.md)、[client.rs](https://github.com/mozilla/sccache/blob/main/src/client.rs)、[net.rs](https://github.com/mozilla/sccache/blob/main/src/net.rs)）
- CLI ↔ daemon は local IPC。TCP（127.0.0.1）または Unix domain socket（Linux では abstract socket も）。接続は Connection で、要求・応答は **length-prefixed bincode**。
- server 側は tokio で複数クライアントを扱う。サーバは storage backend と統計を保持する。
- 既定は server-side mode（CLI はコンパイルを daemon に任せ、stdout/stderr と exit code だけ受け取る）。client-side mode もある。

**多重化**: 接続ごとに 1 要求・応答。複数クライアントは server が並列に扱う。要求 id は不要（接続が対応を持つ）。

**cancel**: 明示の cancel はない。CLI が死ねば接続が切れる。

**idle / 終了**: SCCACHE_IDLE_TIMEOUT。既定は **600 秒**（DEFAULT_IDLE_TIMEOUT: u64 = 600）。0 で永久常駐。SCCACHE_NO_DAEMON=1 で daemon 化を無効化。([server.rs](https://github.com/mozilla/sccache/blob/main/src/server.rs) / [Configuration](https://github.com/mozilla/sccache/blob/main/docs/Configuration.md))

**crash / 復帰**: CLI は server に接続できなければ起動を試み、失敗時に retry する（backon を使う）。server が落ちれば次の CLI が新しい server を起動する。local storage は同時に 1 server だけを前提にしている。

**性能**: キャッシュヒット時のコンパイル回避が目的で、server 自体の起動時間の公表値はない。

### 2.7 gopls / rust-analyzer / tsserver

- **gopls**: Go の language server。LSP でエディタと話し、ワークスペースごとに常駐する。更新後は「running Gopls processes を再起動する必要がある。再起動の方法はクライアントごとに違う」と案内している。([gopls](https://go.dev/gopls/))
- **rust-analyzer**: LSP サーバ。エディタ配下で常駐し、ワークスペースの解析状態を保持する。([rust-analyzer book](https://rust-analyzer.github.io/book/))
- **tsserver**: TypeScript の standalone server。stdin に JSON、stdout に **Content-Length ヘッダ付き**の JSON を書く。要求は seq、応答は request_seq で対応付ける。イベント（diagnostics など）は応答とは別に流れる。エディタがプロセスを起動・再起動する。([tsserver wiki](https://github.com/microsoft/TypeScript/wiki/Standalone-Server-(tsserver)))

3 者とも「常駐して解析状態を持つ」「プロトコルは LSP か tsserver の JSON」「再起動はクライアント（エディタ）が決める」という同じ形。idle 終了はエディタがワークスペースを閉じたとき。**性能の公表値**: 3 者とも起動時間・スループットの公式値はない。常駐の目的はワークスペースの再インデックスを避けること。

### 2.8 VS Code / JetBrains の VFS と常駐プロセス

**VS Code**
- ファイル I/O 本体（DiskFileSystemProvider）は **Electron main process** で Node の fs を直接使う。VFS のための常駐 I/O daemon は持たない。
- ファイル監視だけは「compute intense」なので **UtilityProcess** に載せ、別プロセスで動かす。recursive は ParcelWatcher、non-recursive は fs.watch。([File-Watcher-Internals](https://github.com/microsoft/vscode-wiki/blob/main/File-Watcher-Internals.md))
- Remote Development では、ファイル I/O はリモート側の VS Code Server（Node プロセス）で行い、UI は RPC 越しに触る。ローカルに VFS daemon を置く代わりに、実行場所を分ける設計。
- なぜ常駐 I/O helper を持たないか: OS の page cache と非同期 fs で十分速く、ワークスペースごとの daemon は RPC のレイテンシとライフサイクルだけを増やす。監視は別で、native watcher のクラッシュ・CPU 消費を本体から隔離する必要がある。

**JetBrains**
- VFS は IDE の JVM プロセス内にある。書き込みは同期的（VFS 経由の write は即ディスクへ）。refresh は非同期で、外部変更を VFS に反映する。([Virtual File System](https://plugins.jetbrains.com/docs/intellij/virtual-file-system.html))
- OS のファイル変更通知を受ける **native file watcher process**（Linux では fsnotifier）を別プロセスで起動する。watcher が使えるときは、refresh は「変更されたと報告されたファイル」だけを見る。使えないときは全走査。([同上](https://plugins.jetbrains.com/docs/intellij/virtual-file-system.html)、[Native file system watcher for Linux](https://blog.jetbrains.com/idea/2010/04/native-file-system-watcher-for-linux/))
- なぜ I/O helper ではないか: エディタの応答性には同一プロセス内の同期アクセスが有利。native watcher だけはプラットフォーム依存 code とクラッシュを隔離するために外出しする。

**性能の公表値**: VS Code の watcher 分離も JetBrains の fsnotifier も、起動時間やスループットの公式値はない（監視の安定性と CPU 隔離が主目的）。

**hns への示唆**: 「I/O 本体は呼び出しプロセス内、重い監視だけ別プロセス」という VS Code の判断は、hns の rooted helper とは条件が違う。hns は **dirfd を保持して TOCTOU を閉じる**ために別プロセスが要る。VS Code の watcher 分離は、hns の watch（ExecutionEnv.watch）を別プロセスに置くかどうかの参考になる。

### 2.9 比較表

| 系統 | protocol | 多重化 | cancel | idle / 終了 | crash からの復帰 | 公表性能 / 実測 |
| --- | --- | --- | --- | --- | --- | --- |
| git cat-file --batch | stdin 1 行 → stdout 連続（内容 + LF） | なし（入力順） | なし | EOF で終了。常駐しない | 呼び出し側が再起動 | 数値なし。--buffer が大幅に効率的 |
| Bazel persistent worker | stdin/stdout。protobuf は varint 長、JSON は 1 行 | request_id（multiplex） | cancel フィールド（実験的） | ビルドをまたいで常駐。--worker_quit_after_build / stdin EOF | invalidate → 再 spawn。strategy fallback | Java 2–4x、Bazel 2.5x |
| LSP | JSON-RPC + Content-Length over stdio | id で対応。並列可 | $/cancelRequest（応答必須） | shutdown → exit。クライアント管理 | クライアントが再起動（maxRestartCount） | 数値なし |
| watchman | Unix socket。JSON 1 行 or BSER | 接続内順序。subscribe は server push | unsubscribe / close | daemon はユーザーごとに常駐。watch は 5 日で reap | 自動 spawn。recrawl で再同期 | 数値なし |
| esbuild service | stdin/stdout。32-bit LE 長のバイナリ JSON | request id + callbacks | cancel 要求 | stop() まで常駐 | 自動再起動なし | 0.39s vs 14.91/34.10/41.21s |
| sccache | local IPC（TCP/UDS）。length-prefixed bincode | 接続ごとに 1 要求 | なし | 600 秒 idle で終了 | 次の CLI が server を起動 | 数値なし（キャッシュ効果） |
| gopls / rust-analyzer | LSP | id | $/cancelRequest | エディタが閉じるまで | エディタが再起動 | 数値なし |
| tsserver | stdin/stdout。Content-Length JSON | seq / request_seq | なし（実装依存） | エディタが閉じるまで | エディタが再起動 | 数値なし |
| VS Code watcher | UtilityProcess + native watcher | 監視要求を集約 | 監視の解除 | ウィンドウ / ワークスペースの寿命 | watcher を再起動（実装依存） | 数値なし |
| JetBrains fsnotifier | 別プロセスの native watcher | 変更通知 | 監視の解除 | IDE の寿命 | IDE が再起動 | 数値なし |
| **hns 現行** | argv + 1 JSON、stdout に 1 JSON | なし（1 操作 1 プロセス） | env.exec の timeout / abort で kill | 毎回終了 | 次の操作は新しいプロセス | **probe 73.6 ms / write 150.7 ms** |
| **hns 提案** | stdio NDJSON。hello + hash/read/commit | request id（処理は直列） | timeout で kill | 60 秒 idle / close / stdin EOF | 1 回再起動、60 秒 3 回で fail closed | **RTT 0.04 ms / hash+commit 0.22 ms** |

## 3. Node の実行基盤

### 3.1 child_process と worker_threads

**child_process.spawn**
- 新しい OS プロセス。V8 isolate・event loop・メモリ空間が別。クラッシュ（native crash を含む）は親に伝播しない。
- IPC は stdio: [..., "ipc"] のときだけ。既定の serialization は JSON、advanced で v8 の structured clone（Buffer / TypedArray / Map / Set など）。subprocess.send は送れたかを boolean で返す。([child_process](https://nodejs.org/api/child_process.html))
- stdio はストリーム。背圧は write() の戻り値と drain で扱う。
- 起動は重い。本機の Node 26 で **p50 33.9 ms**（node -e ""）。helper の module load を含めると **73.6 ms**。
- ライフサイクル: spawn → spawn イベント → exit → close。kill はシグナル、timeout は呼び出し側。error は起動失敗。worker は online → message → error / exit で、terminate() で止める。
- メモリは子プロセスあたり **約 73 MB RSS**（Node 26、単純な server）。

**worker_threads**
- 同一プロセス内の別スレッド。V8 isolate と event loop は別だが、メモリ空間と fd table は共有する。
- postMessage は structured clone。ArrayBuffer は transfer でゼロコピー。SharedArrayBuffer は共有。
- 起動は **p50 9.8 ms**、RSS 増分は **+12 MB**。
- Node のドキュメントは「Worker は CPU 集約的な処理向け。I/O 集約的な処理にはあまり役立たない。Node の非同期 I/O の方が効率的」と明記する。([worker_threads](https://nodejs.org/api/worker_threads.html))
- worker 内の uncaught exception は error イベントになり、worker は終了する。親は生き残る（リスナーがある場合）。ただし native addon の SIGSEGV などはプロセス全体を落とす。
- 重要な実測: **main thread で開いた dirfd を worker から /proc/self/fd/<fd>/<name> で読める**。fd table はプロセス共有なので、worker 案でも dirfd 方式は技術的に成立する（実測: WORKER_FD_RESULT "hello-from-dirfd"）。

**どちらが hns に向くか**
- 性能だけなら worker（起動 9.8 ms、RTT 0.02 ms、メモリ +12 MB）が良い。
- しかし (a) 初回 write は 9.8 ms + fs で 10 ms 境界、(b) Rooted の呼び出しは ExecutionEnv.exec の seam に乗っており、worker はその seam を外れる、(c) TS worker をビルドするか type stripping に依存する、(d) native crash の隔離が弱い、(e) 子プロセスなら Landlock / bwrap / rlimit を後から足せる、という理由で child を先に採る。
- worker は「メモリが支配的なとき」の代替として残す。1 helper 73 MB は、同時に多数のワークスペースを開くサーバでは効いてくる。

### 3.2 実測（コマンドと生値）

実行した主なコマンド:

~~~text
NODE26=/nix/store/ywwchijlngjj756gqp3izz8xw6q8cca2-nodejs-26.13.0/bin/node
BENCH_N=15 BENCH_NODES="$NODE26,/run/current-system/sw/bin/node" "$NODE26" bench.mjs
~~~

bench.mjs は次のフェーズを順に測る（各 15 回、最初の 2 回は warmup）:
1. spawn(node, ["-e", ""]) の exit まで
2. spawn(node, ["-e", "process.stdout.write(...)"]) の exit まで
3. 実際の helper を probe で起動（cwd は repo）
4. stdio 常駐 server の起動（spawn → ready）
5. stdio の RTT（20 回）、8 並列、1 MiB 応答
6. SIGKILL → exit 検出、再起動 → ready
7. IPC（spawn + ipc channel）の起動、RTT、8 並列、1 MiB
8. fork の起動
9. worker の起動（eval / file）、RTT、8 並列、1 MiB transfer
10. 子プロセスの RSS、worker の RSS 増分

生値（Node 26.13.0 / 本機）:

| 項目 | p50 | p95 | min | max |
| --- | ---: | ---: | ---: | ---: |
| spawn empty | 33.86 | 39.73 | 30.10 | 39.99 |
| spawn + stdout write | 36.92 | 38.78 | 33.65 | 42.44 |
| helper probe（.ts + valibot） | 74.00 | 75.79 | 72.22 | 76.46 |
| stdio 起動（spawn → ready） | 36.45 | — | — | — |
| stdio RTT | 0.04 | 0.07 | 0.02 | 0.07 |
| stdio 8 並列 | 0.07 | 0.08 | 0.05 | 0.27 |
| stdio 1 MiB | 4.10 | 6.53 | 2.64 | 6.59 |
| IPC 起動 | 36.64 | — | — | — |
| IPC RTT | 0.03 | 0.21 | 0.01 | 0.26 |
| IPC 8 並列 | 0.05 | 0.05 | 0.04 | 0.06 |
| IPC 1 MiB | 3.54 | 4.15 | 1.69 | 4.45 |
| fork 起動 | 33.01 | — | — | — |
| worker 起動（eval） | 9.78 | 10.98 | 8.91 | 11.15 |
| worker 起動（file） | 9.52 | 10.33 | 8.67 | 11.54 |
| worker RTT | 0.02 | 0.02 | 0.01 | 0.03 |
| worker 8 並列 | 0.02 | 0.02 | 0.02 | 0.03 |
| worker 1 MiB transfer | 0.35 | 0.46 | 0.33 | 0.67 |
| 子プロセス RSS | 73.1 MB | — | — | — |
| worker RSS 増分 | 12.0 MB | — | — | — |
| SIGKILL → exit 検出 | 4.2 ms | — | — | — |
| SIGKILL → 再起動 ready | 34.7 ms | — | — | — |

起動の行（stdio / IPC / fork）は n=1 の参考値。worker 起動は n=15。

Node 24.22.2（比較）:

| 項目 | p50 | p95 |
| --- | ---: | ---: |
| spawn empty | 20.82 | 22.74 |
| helper probe | 65.48 | 67.64 |
| worker 起動（eval） | 9.28 | 9.88 |
| stdio RTT | 0.04 | 0.06 |
| IPC RTT | 0.03 | 0.05 |
| 子プロセス RSS | 66.4 MB | — |
| worker RSS 増分 | 11.5 MB | — |

Node 26 は Node 24 より spawn が約 13 ms 遅い。flake は 26 を pin しているので、上の 26 の値が判断対象。

追加の実測（helper の分解と 8 MiB）:

| 項目 | 値 |
| --- | ---: |
| helper を引数なしで起動（.ts、usage で exit 2） p50 | 74.5 ms |
| helper を引数なしで起動（dist の .js） p50 | 43.5 ms |
| env.exec 経由の helper probe p50 / p95 | 73.6 / 77.1 ms |
| 1 回の helper read（8 MiB） p50 | 103.4 ms |
| 常駐 helper の 8 MiB 応答（fair な stdio） p50 | 21.9 ms |
| 常駐 helper の 8 MiB 応答（IPC） p50 | 27.0 ms |
| worker の 8 MiB transfer p50 | 2.86 ms |
| 11 MB の JSON.parse p50 | 6.53 ms |
| 素朴な文字列連結で 8 MiB を受けた stdio p50 | 351.2 ms |

最後の 351 ms は protocol の限界ではなく、クライアントの buf += chunk と毎回の indexOf による O(n²) の実装ミス。チャンクごとに改行を探して Buffer.concat する実装に変えると 21.9 ms になる。**常駐 helper の実装では、応答のフレーミングをチャンク単位で行うこと**。

### 3.3 stdio と process.send のどちらが適するか

| 観点 | stdio（NDJSON） | process.send（IPC） |
| --- | --- | --- |
| フレーミング | 自前（改行区切り）。JSON は改行をエスケープするので安全 | Node がメッセージ境界を付ける |
| 大きい本文 | fair で 8 MiB 21.9 ms。素朴な実装だと O(n²) | 8 MiB 27.0 ms。structured clone は Buffer をそのまま送れる（advanced） |
| 背圧 | stdin.write の戻り値 + drain | send の戻り値 + channel の drain |
| 言語非依存 | 高い（git / LSP / watchman / esbuild / sccache と同じ） | Node 専用。Go などに移すと IPC の再実装が要る |
| デバッグ | stdout をログに混ぜない規律が要る。stderr にログ | stdout/stderr は自由。メッセージは channel |
| 環境 seam | spawn の stdio だけでよい | spawn に ipc channel が要る |

**判断**: stdio NDJSON を採る。理由は (a) 将来 helper を Go / Rust にしても protocol が変わらない、(b) env.exec と同じ「stdout が応答」の規律を引き継げる、(c) 実測で IPC と同等以上。process.send は「Node 専用でよい・大きい Buffer をそのまま送りたい」となったときの最適化として残す。

**フレーミングの推奨**:
- 1 行 1 メッセージ。要求 {id, op, ...}、応答 {id, ok, ...}。id は単調増加の整数。
- stdout は応答専用。ログは stderr。パス・本文はログに出さない（既存の方針）。
- 1 行の上限を決める（read は 8 MiB → base64 で約 11.2 MB。JSON を含めて 12 MB 程度。上限 16 MiB など）。
- 応答が上限を超える場合は too_large を返す（既存の MAX_READ と同じ）。
- 改行を含む文字列は JSON がエスケープするので、行分割は安全。NUL は JSON では \u0000 になる（実際の改行にはならない）。

### 3.4 現行 helper のコスト分解と常駐化の試作

現行の write は [workspace.ts](../../packages/workspace/src/workspace.ts) の #write で、
1. #resolve（env.exists / readTextFile / canonicalPath）
2. #versionOfFile → Rooted.hash（helper 1 回）
3. journal の intent 保存
4. temp の write + flush
5. #commitRooted → Rooted.commit（helper 1 回、再ハッシュ + rename）
6. 事後の canonical 確認
7. journal の outcome 保存 + イベント

となる。helper は 2 回で、実測 p50 **150.7 ms**。read は 1 回（約 74 ms）、open は probe 1 回（約 74 ms）。

試作: root の dirfd を 1 回だけ開いて保持し、hash と commit を NDJSON で受ける小さな server を /tmp に置き、同じ順序で測った。

| 経路 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| 現行: hash spawn + commit spawn | 150.67 ms | 154.21 ms | 154.36 ms |
| 常駐: spawn → ready | 38.19 ms | — | — |
| 常駐: hash + commit の 2 RPC（warm） | **0.22 ms** | **0.45 ms** | 0.81 ms |

常駐化すると、write の helper 部分は 150.7 ms → 0.22 ms。journal の write + flush + rename と temp の write + flush は checks 経路の実測（0172 の 2.5 ms）と同じなので、write 全体は **約 2.7 ms** と見積もれる（推測。実装後に C3 で確定する）。

## 4. パス封じ込め

### 4.1 openat2（Linux 5.6+）

[openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html) は openat の拡張で、struct open_how に flags / mode / resolve を渡す。resolve フラグ:

- **RESOLVE_BENEATH**: dirfd の子孫でない解決を拒否する。絶対 symlink と絶対パスを拒否する。現在は magic-link も無効化するが、将来変わり得るので明示的に RESOLVE_NO_MAGICLINKS を付けるべき。
- **RESOLVE_IN_ROOT**: dirfd を root のように扱う。絶対 symlink は dirfd 相対で解釈し、.. は root で止まる（chroot 相当）。
- **RESOLVE_NO_SYMLINKS**: 解決中の symlink をすべて拒否する。RESOLVE_NO_MAGICLINKS を含意する。
- **RESOLVE_NO_MAGICLINKS**: magic-link（/proc/self/fd など）を拒否する。
- **RESOLVE_NO_XDEV**: mount point を跨ぐ解決を拒否する。
- 失敗時は how.resolve に原因フラグが入る。EAGAIN は「.. が escape しないことをカーネルが保証できなかった」場合で、再試行できる。

**注意**: glibc は openat2 の wrapper を提供していない。syscall(SYS_openat2, ...) を使う必要がある（man page に明記）。Node の fs は openat2 も O_PATH も公開していない（本機の Node 26 で fs.constants.O_PATH は undefined、O_DIRECTORY と O_NOFOLLOW はある）。したがって openat2 を使うには native addon か、Go / Rust の helper が要る。

### 4.2 Go 1.24 の os.Root

- [Go 1.24 release notes](https://go.dev/doc/go1.24): os.Root は「特定のディレクトリ内でファイルシステム操作を行う。ディレクトリの外を指すパス（symlink 経由を含む）は許さない」。
- [os.Root](https://pkg.go.dev/os#Root): Root のメソッドは root の下だけを触る。ファイル名は root 自身（.）を参照してよい。**symlink は follow するが、root の外を参照してはいけない。symlink は絶対パスであってはいけない**。root をまたぐ renames は Unix では fd で追跡する。
- 実装（[root_openat.go](https://github.com/golang/go/blob/master/src/os/root_openat.go)）は openat / mkdirat などの *at syscall をコンポーネントごとに呼ぶ。openat2 は使っていない。root は fd を保持し、refcount で Close を遅らせる。symlink は最大 8 回（rootMaxSymlinks = POSIX SYMLOOP_MAX の最小値）。
- つまり Go は「openat + fd + コンポーネント検証」で openat2 に依存せず封じ込める。hns の /proc/self/fd 方式と発想は近い（fd を基準にする）が、Go は *at syscall を直接使える言語だから /proc が不要。

### 4.3 Rust の cap-std / openat / libpathrs

- **cap-std**: capability-based な std。Dir::open は Linux 5.6 以降で **openat2** を使い、common case を 1 syscall で解決する。その他は openat2 / O_PATH / /proc/self/fd を使う（/proc が mount されている場合）。FreeBSD 13+ は openat(O_RESOLVE_BENEATH)。root の外を指すパスは PermissionDenied。([cap-std](https://github.com/bytecodealliance/cap-std))
- **libpathrs**: container runtime 向けの safe path resolution。resolver を 3 つ持つ:
  - **openat2**: RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS を付けて 1 syscall で解決する（[openat2.rs](https://github.com/cyphar/libpathrs/blob/main/src/resolvers/openat2.rs)）。
  - **O_PATH ベースの userspace resolver**: openat2 が使えない環境向け。symlink stack を持ち、最大 128 回の symlink を許す。
  - **procfs**: /proc の限定的な lookup 用。
  - 既定は自動検出（Resolver::default）。([libpathrs](https://github.com/cyphar/libpathrs)、[resolvers.rs](https://github.com/cyphar/libpathrs/blob/main/src/resolvers.rs))
- この 2 つは「openat2 が第一、O_PATH + /proc が fallback」という hns の将来像の参考になる。hns は Node なので、まず /proc/self/fd（O_PATH なし）で始め、openat2 / O_PATH が要る段階で native helper を検討するのが現実的。

### 4.4 Landlock

- Landlock は「ambient rights（グローバルなファイルシステム / ネットワークアクセス）をプロセスの集合に対して制限する」ための stackable LSM。root 権限なしで使える。([kernel docs](https://docs.kernel.org/userspace-api/landlock.html))
- ルールセットは「スレッドとその将来の子プロセス」を制限する。landlock_restrict_self が成功すると、そのスレッドは制限され、以後の子にも継承される。**一度 landlocked になるとポリシーを外す方法はない。追加の制限だけができる**。
- ファイルシステムのルールは「ファイル階層」と「許可する access rights」。path の解決を atomic にするものではない。dirfd の代替ではない。
- hns での使い道: helper プロセスを「root の下と /proc だけ」に制限する defense in depth。ただし (a) open 済み fd は制限後も使える、(b) /proc を許可しないと /proc/self/fd が壊れる、(c) ABI の確認が要る、という注意がある。0191 の必須要件ではなく、将来の hardening。

### 4.5 git / watchman / bazel はパスをどう封じ込めているか

- **git**: リポジトリ探索は chdir で祖先を辿る（[setup.c](https://github.com/git/git/blob/master/setup.c) に chdir(gitdirenv) など）。作業ツリーのファイル操作は cwd 相対のパスが中心で、少なくとも checkout 経路に dirfd による封じ込めはない。checkout の [entry.c](https://github.com/git/git/blob/master/entry.c) には openat / renameat がなく、通常の open / rename を使う。GIT_CEILING_DIRECTORIES は探索の上限を決めるが、任意パスの封じ込めではない。git は「信頼できるユーザーが自分のリポジトリで作業する」前提で、hns の threat model とは違う。
- **watchman**: watch-project が realpath(3) で root を解決し、その下を監視する。クエリは watch root 相対のパスを返す。glob は symlink を follow せず、since は symlink の target を見ない。dirfd で各操作を封じ込める API はない。監視対象の同一性は path で持つ（dirfd ではない）。
- **bazel**: 一般の action は sandbox（symlink forest、namespace、--sandbox_writable_path など）で入出力を制限する。persistent worker は「/bazel-workers 配下の専用 cwd を持つが chroot はされない」。--worker_sandboxing を付けると **要求ごとに sandbox ディレクトリ**を作り、入力をそこに置く。multiplex の sandbox は sandbox_dir を各要求が使う。([Persistent Workers](https://bazel.build/remote/persistent)、[Multiplex Workers](https://bazel.build/remote/multiplex)、[Sandboxing](https://bazel.build/docs/sandboxing))
- 3 者とも「hns のように untrusted path を dirfd で封じ込める」設計ではない。hns の dirfd 方式は、この中ではむしろ libpathrs / cap-std に近い。

### 4.6 現在の helper の /proc/self/fd 方式

現行の [rooted-helper.ts](../../packages/workspace/src/rooted-helper.ts) は、root を O_RDONLY | O_DIRECTORY | O_NOFOLLOW で開き、各親を同じ flags で辿り、/proc/self/fd/<dirfd>/<name> を open / rename する。root の dev / ino と .hns/root.json の id を毎回照合する。

**長所**
- Node の fs API だけで openat 相当ができる。native addon が不要。
- 各コンポーネントを O_NOFOLLOW で開くので、親の差し替えを辿らない。rename も親 dirfd から行う。
- openat2 が無いカーネル（5.6 未満）でも動く。Linux の procfs がある環境なら FS を選ばない。
- fd は開いた時点のディレクトリを指すので、パスの差し替えに対して強い。
- 実装が小さく、テスト（TOCTOU / hardening）が既にある。

**短所**
- **procfs が必須**。/proc が masked / 無い sandbox（一部のコンテナ、chroot）では動かない。動かないときは checks に落ちる（fail open ではないが、封じ込めが弱くなる）。
- **magic-link 依存**。openat2 の RESOLVE_NO_MAGICLINKS とは相容れない。将来 openat2 を併用するなら設計を分ける必要がある。
- **O_PATH が使えない**（Node の fs.constants に無い）。ディレクトリに read 権限が無いが execute 権限だけある場合、O_PATH なら開けるが O_RDONLY では開けない。hns の root はユーザーの作業ディレクトリなので通常は問題ないが、限定条件として記録する。
- **renameat2 / RENAME_EXCHANGE が使えない**。Node の fs は renameat2 を公開しない。CAS（compare-and-exchange）を入れるには native helper が要る（[docs/workspace.md](../../docs/workspace.md) の既知の残り窓）。
- **パスの長さ**。/proc/self/fd/<fd>/<name> は約 16 文字を足す。NAME_MAX / PATH_MAX の余裕がわずかに減る。
- **fd の寿命**。現行は 1 操作ごとに開いて閉じる。常駐化するなら root fd を保持し、fd 番号を再利用しない（close しない）ことが前提。fd を閉じた後に番号が再利用されると別の dir を指す危険があるため、helper の寿命 = root fd の寿命にする。
- **per-op の再オープン**。現行は毎回 root を path で開き直す。常駐化ではこれをやめ、hello で開いた fd を保持する方が安全かつ速い（path の再解決をしない）。

**常駐化での注意**: root fd を保持すると、root の path が差し替えられても操作は元のディレクトリに留まる。これは封じ込めとしては強いが、「root が置き換わった」ことを helper が検知しにくくなる。Workspace 側の #verifyIdentity（毎回 .hns/root.json を path で読む）が先に Denied にするので、二重の防御になる。helper 側でも fstat(rootfd) の dev / ino と st_nlink > 0 を per-op で見るのが安い（推測: fstat は µs 台）。

## 5. 失敗と運用

### 5.1 起きる失敗

| 失敗 | 現行 | 常駐化で必要になる扱い |
| --- | --- | --- |
| helper が起動しない（exec 不可 / helper 不在） | probe が failed → checks（required なら Unavailable） | 同じ。常駐化の spawn 失敗も同じ扱い |
| helper が要求中に落ちる | その操作だけ failed。次の操作は新しいプロセス | pending を helper_unavailable で失敗。次の操作で 1 回だけ再起動 |
| helper が不正な応答を返す | parseReply が failed("io") | 応答の JSON 不正・id 不一致・途中で切れた行は **protocol failure** として kill。期待されるエラー（not_found など）とは区別する |
| 1 要求だけ失敗する（not_found / conflict） | failed outcome を返して終了 | failed outcome を返して **プロセスは維持**。再起動しない |
| timeout | env.exec の timeout が kill | per-request timer。超えたら helper を kill し、pending を失敗。fs の block は協調キャンセルできない |
| idle | なし（毎回終了） | 60 秒で close。timer は unref。pending 中は close しない |
| 親の終了 | 子は残らない | stdin EOF で helper が終了（実測）。close / kill の best effort も入れる |
| orphan | 起きない | idle timer を unref しないと、親が死んでも timer の分だけ残る（実測: timer ありは ALIVE、unref は exited） |
| zombie | 起きない | Node / libuv が reap する。exit を待ち、二重 kill しない |
| 子が大量に残る | 起きない | 1 root = 1 helper。同時数の上限（LRU）と idle close。RSS 73 MB / helper を監視 |

### 5.2 既製品の扱いとの比較

| 系統 | 1 要求の失敗 | crash | timeout | orphan 防止 |
| --- | --- | --- | --- | --- |
| git cat-file | その object のエラー。プロセスは継続（バッチ） | 呼び出し側が再起動 | 呼び出し側 | なし（短命） |
| Bazel worker | WorkResponse の exit_code / output。worker は継続 | invalidate → 再 spawn。strategy fallback | Bazel が worker を kill / cancel（実験的） | Bazel サーバが stdin を閉じる。--worker_quit_after_build |
| LSP | error response。サーバは継続 | クライアントが再起動（maxRestartCount） | クライアントが kill | 親の processId を見て終了。shutdown / exit |
| watchman | エラー応答。接続は継続 | 次のクライアントが daemon を spawn | クライアント | daemon はユーザーごと。shutdown-server |
| esbuild | error response。service は継続 | 呼び出し側が新しい service | cancel 要求 | service は明示 stop / プロセス終了 |
| sccache | error response。server は継続 | 次の CLI が server を起動 | クライアント | server は idle 600 秒で終了 |
| hns 提案 | failed outcome。プロセス継続 | 1 回再起動、60 秒 3 回で fail closed | kill + pending 失敗 | stdin EOF + close + timer unref |

## 6. hns への推奨 R1–R6

### R1（U-01）: 1 root = 1 常駐 child process を採る

**決定**: A。Rooted は root ごとに 1 つの child process を持ち、root の dirfd をその process の寿命だけ保持する。worker thread は採らない（次点として設計に残す）。

**理由（実測）**:
- 現行 write 150.7 ms のうち、helper 起動が約 148 ms。常駐化で 0.22 ms になる。
- 目標 write < 10 ms は、常駐 + 既存の fs 操作（約 2.5 ms）で満たせる。
- child は crash 隔離が最も強く、LSP / watchman / sccache / Bazel と同じ「プロセスを分けて状態を持つ」形。
- ExecutionEnv の exec は要求ごとに完結する API なので、常駐には新しい port が要る（R2）。これは既存の seam を壊さずに足せる。

**代償と対策**:
- RSS 約 73 MB / helper。idle 60 秒で閉じる。同時に多数開く場合は LRU で上限を設ける（例: 8）。上限に達したら最も古い idle helper を閉じる。
- probe の 38–74 ms は Workspace.open のコストとして残る。テストでは openWorkspace の呼び出しが 44 箇所あり、ループを含めると実行回数はそれ以上。8 ファイル並列なので実測の 6.8 s のうち probe は約 0.7 s/ファイル以下。常駐化後の integration は 1–2 s に収まる見込み（推測。C3 で確定）。
- worker 案は、メモリが支配的になったときの代替。fd 共有は実測で確認済み。

**却下した案**:
- B 単独: 1 spawn 74 ms で 10 ms に届かない。
- D 単独: .js 43.5 ms でも届かない。常駐化後の probe / 再起動の短縮としては有効だが、toolchain を増やすほどではない。
- C: 起動 9.8 ms / p95 11.0 ms で初回 write が境界。seam・ビルド・隔離の代償。

### R2（U-02）: port と protocol

**決定**: Rooted の入力に、ExecutionEnv とは別の小さな HelperPort を足す。ExecutionEnv は変えない（[rooted.ts](../../packages/workspace/src/rooted.ts) の RootedInput に helper: HelperPort を追加する形）。テストが実装し、machine 側の配線は 0157 / 0194 で行う。

~~~ts
interface HelperProcess {
  request(req: HelperRequest, options?: { timeoutMs?: number }): Promise<HelperReply>;
  close(): Promise<void>;
  readonly pid: number | undefined;
}

interface HelperPort {
  spawn(input: {
    root: string;
    id: string;
    env: ExecutionEnv;
    context: Context;
  }): Promise<HelperProcess>;
}
~~~

- **hello**: spawn 直後に {op:"hello", root, id} を送る。helper は root を開き、dev / ino と marker id を検証して {ok, dev, ino} を返す。以降の要求は root を再送しない（helper が保持する）。
- **ops**: hash / read / commit。commit は現行どおり再ハッシュ + rename を 1 要求で行う。probe は hello に吸収する。
- **framing**: NDJSON。{id, op, ...} / {id, ok, ...}。stdout は応答専用、stderr はログ。1 行の上限を 16 MiB にし、超えたら too_large。
- **多重化**: id で pending を対応付ける。helper は到着順に処理する（直列）。workspace の write 順序を保ち、rename の競合を増やさないため。並列化が必要になったら、commit の順序保証を別に設計する。
- **背圧**: stdin.write が false なら drain を待つ。helper 側も大きい応答は write の戻り値を見て drain を待つ。
- **cancel**: 初期実装は per-request timeout で kill。協調 cancel はファイル操作が短いので不要。将来、read が大きい場合に {op:"cancel", id} を足す余地を残す。
- **エラーの分類**: {ok:false, code} は期待される結果（プロセス継続）。JSON 不正・id 不明・途中で切れた行・EPIPE は protocol failure（kill + pending 失敗）。多重化して複数が pending のとき、1 つの failed outcome はその id だけに返し、他は継続する。protocol failure は全 pending を失敗させる（プロセスを捨てるため）。
- **なぜ stdio か**: 3.3 の比較。言語非依存で、git / LSP / watchman / esbuild / sccache と同じ。process.send は Node 専用の最適化として保留。

**実装上の注意**:
- 行の蓄積はチャンク単位で行う（3.2 の 351 ms の教訓）。
- stdout に helper のログを混ぜない。console.log を禁止し、process.stderr.write を使う。
- helper の起動は detached: false、stdio は ["pipe","pipe","pipe"]。process.on("exit") で best effort の kill。
- helper は stdin の end で process.exit(0)（明示ハンドラ）。idle timer は unref。

### R3（U-03）: crash の扱い

**決定**:
- pending の要求は helper_unavailable で失敗させる。**黙って成功させない**。
- 次の操作で **1 回だけ** 再起動する。再起動の hello で root / marker を再検証する。root が無ければ Denied("root missing")、marker が違えば Denied("root replaced")。
- **60 秒以内に 3 回** 落ちたら fail closed。以後は Unavailable("the rooted helper is unstable") を返し、再起動しない。成功した操作でカウンタをリセットするかは実装で決める（推奨: 成功でリセットしない。3 回 / 60 秒の窓で数える）。
- **checks へは落とさない**。rooted: "required" は失敗のまま。既定の rooted でも、一度 dirfd モードで開いた後に checks へ落ちると封じ込めが弱くなるので、落とさない。開く前の probe 失敗だけが checks へのフォールバック。
- 期待される失敗（not_found / conflict / is_directory など）は crash に数えない。
- timeout（例: 5 秒）は kill + pending 失敗。crash と同じカウンタに数えるかは別にする（推奨: 数える。同じ「helper が応答しない」障害）。
- 再起動の上限に達したら、Workspace は mode を変えずに失敗を返す。呼び出し側が閉じて開き直すのは自由。

**テスト（C2）**:
- テスト用の HelperPort で子を kill し、次の write が 1 回だけ再起動して成功することを確認。
- 3 回 kill し、4 回目が Unavailable で失敗することを確認。
- kill 中に pending だった要求が成功として返らないことを確認。
- 再起動後に root を差し替え、Denied になることを確認。

### R4（U-04）: idle / close

**決定**:
- lazy spawn: 最初の操作で spawn。Workspace.open の probe / hello は 1 回だけ。
- idle **60 秒**。要求のたびに timer をリセット。timer は **unref**。pending 中は close しない。
- Workspace.close で必ず helper を閉じる。Rooted.close() を追加し、[workspace.ts](../../packages/workspace/src/workspace.ts) の close（現在は watcher だけ）から呼ぶ。open が途中で失敗したときも閉じる。
- close の手順: 新規要求を拒否 → pending を最大 1 秒待つ → stdin を end → SIGTERM → 1 秒で SIGKILL → exit を待つ。冪等。
- 親の終了: stdin EOF で helper が終了する（実測: plain は exited、timer ありは ALIVE、timer-unref は exited）。process.on("exit") の best effort kill も入れる。
- helper 側にも「stdin が end したら exit」を明示する。idle timer は unref。これで orphan が残らない。
- **注意**: 同時に開ける Workspace は journal ごとに 1 つ（JOURNAL_CLAIMS）。同じ root でも journal が違えば別の Workspace として開けるが、その場合も helper は Workspace ごとに 1 つなので、root fd はそれぞれ独立に持つ。テストで同じ root を開き直す場合は、close で helper が閉じ、次の open で新しい helper が spawn される。これは正しい（root fd を作り直す）が、テスト時間は増える。R5 で扱う。

### R5（U-05）: テストの helper 再利用

**決定**:
- 本番は Workspace ごとに 1 helper。root を跨がない。
- テストはまず「Workspace ごとに 1 helper」で測る。44 箇所の open × 74 ms は 8 ファイル並列で吸収できる見込み。integration が 3 s を超えた場合だけ、test/support.ts に **root キーの pool** を足す。
- pool の形: Map<canonicalRoot, { process, refs }>。withTarget の finally で refs を減らし、0 で close。テスト間で root は共有しない（mkdtemp がテストごとに違う）。同じ root を開き直すテスト（crash / recover / concurrent）だけが再利用の恩恵を受ける。
- pool は **本番コードに入れない**。テスト専用の HelperPort 実装に閉じる。
- helper を suite で 1 個だけ使い、複数 root を 1 プロセスに serving させる案は採らない。root fd の寿命と crash の影響範囲が曖昧になり、本番の「1 root = 1 helper」と乖離する。
- 故障注入（C2）はテスト用 HelperPort の wrapper で行う。本番の Rooted にテストフックを足さない。

**補足**: テストの helper は src の .ts なので 74 ms。dist の .js（43.5 ms）を test から使う案は、build 依存を作るので採らない。probe のコストが問題になったら、helper の module load を減らす（valibot を helper から外す、protocol を軽くする）方が先。

### R6（計測・ゲート・故障注入）

**決定**:
- **C3 の計測**: issue の表に before / after を残す。workload は「同じ root で 50 write + 50 read + 10 open」。warmup の後、p50 / p95 を出す。write は hash + commit + journal を含む end-to-end。目標は write p95 < 10 ms、integration < 3 s。
- **C4 のゲート**: [tools/gate/main.ts](../../tools/gate/main.ts) の内側のループ（現在は stage 単位で gate: <stage> ok (Nms) だけ）に、run ごとの時間を足す。run はパッケージ / プロジェクト単位なので、gate: test <pkg> ok (Nms) が読めるようになる。stage の集計は残す。
- **C2 の故障注入**: テスト用 HelperPort で kill / restart / timeout を注入する。本番コードに crashAt を足さない。
- **RSS の監視**: helper の RSS をログに残す（パスや本文は出さない）。1 root = 1 helper の上限を決める材料にする。
- **flaky にしない**: ベンチマークを CI の合否にしない。issue の表とゲートの実測で固定する（0191 の設計案と同じ）。integration の 3 s は、このマシンで再測した 6.8 s を基準に、常駐化後の値を同じコマンドで比べる。

## 7. 0191 の受入への影響

### 7.1 見込み

| 受入 | 現状（本機再測） | 常駐化後（見込み） | 根拠 |
| --- | --- | --- | --- |
| write < 10 ms | 150.7 ms（helper 2 回） | 約 2.7 ms（p95 も < 10 ms） | 試作 0.22 ms + checks 経路 2.5 ms（推測） |
| integration < 3 s | 6.8 s / 48 tests | 1–2 s | spawn 支配の内訳（churn test 3053 ms = 21×2×74 ms） |
| 失敗時の扱い | 操作ごとに独立 | 1 回再起動 / 3 回で fail closed | R3 |
| ゲートの時間 | stage 単位 | run（パッケージ）単位 | R6 |
| 既存テスト | 48/48 | 同じ 48/48（C1） | helper の入出力契約を保つ |

### 7.2 before / after の表（issue に残す雛形）

| 操作 | before（spawn/op） | after（常駐） | 条件 |
| --- | ---: | ---: | --- |
| open（probe 1 回） | 73.6 ms | 38.2 ms（spawn → hello） | p50、warm なし |
| write（hash + commit） | 150.7 ms | 0.22 ms（helper 部分） / 約 2.7 ms（全体、推測） | p50 |
| read（1 回） | 74 ms | 0.04 ms（RPC） + fs | p50 |
| integration（workspace） | 6.8 s（48 tests） | 1–2 s（推測） | vitest run --project workspace-integration |

### 7.3 実装順

1. HelperPort と NDJSON の protocol（R2）。テスト用の in-process / spawn 実装。
2. Rooted を port 経由に変え、hello / hash / read / commit を実装。probe を hello に吸収。
3. crash / idle / close（R3 / R4）。Workspace.close から Rooted.close。
4. integration を測る。3 s を超えたら R5 の pool。
5. C2 の故障注入、C3 の計測、C4 のゲート。

## 8. 出典と確度

### 8.1 確認済み（一次資料を読んだもの）

| 内容 | URL |
| --- | --- |
| git cat-file の batch / --buffer / --unordered / 入力順 | <https://git-scm.com/docs/git-cat-file> |
| Bazel persistent worker の概要・性能・sandboxing・quit | <https://bazel.build/remote/persistent> |
| Bazel worker の実装要件・stdin/stdout・長さプレフィックス | <https://bazel.build/remote/creating> |
| Bazel multiplex の WorkerProxy / request_id / sandbox_dir | <https://bazel.build/remote/multiplex> |
| Bazel worker_protocol.proto（request_id / cancel / sandbox_dir） | <https://github.com/bazelbuild/bazel/blob/master/src/main/protobuf/worker_protocol.proto> |
| Bazel WorkerOptions（worker_multiplex / cancellation / quit） | <https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/worker/WorkerOptions.java> |
| Bazel WorkerSpawnRunner（cancel / invalidateAndClose） | <https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/worker/WorkerSpawnRunner.java> |
| LSP の lifecycle / initialize / shutdown / exit / cancel | <https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/> |
| LSP initialize の processId と順序 | <https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/general/initialize.md> |
| LSP shutdown の意味 | <https://github.com/microsoft/language-server-protocol/blob/gh-pages/_includes/messages/3.17/shutdown.md> |
| LSP exit の code | <https://github.com/microsoft/language-server-protocol/blob/gh-pages/_includes/messages/3.17/exit.md> |
| vscode-languageclient の CloseAction / maxRestartCount | <https://github.com/microsoft/vscode-languageserver-node/blob/main/client/src/common/client.ts> |
| watchman の per-user daemon / Unix socket / JSON / BSER | <https://meta.github.io/watchman/docs/socket-interface> |
| watchman subscribe（接続 close で解除） | <https://meta.github.io/watchman/docs/cmd/subscribe> |
| watchman idle_reap_age_seconds（既定 5 日） | <https://meta.github.io/watchman/docs/config> |
| watchman recrawl | <https://meta.github.io/watchman/docs/troubleshooting> |
| watchman watch-project の realpath | <https://meta.github.io/watchman/docs/cmd/watch-project> |
| watchman の glob / since と symlink | <https://meta.github.io/watchman/docs/file-query> |
| watchman shutdown-server | <https://meta.github.io/watchman/docs/cmd/shutdown-server> |
| esbuild の service と protocol | <https://esbuild.github.io/api/> |
| esbuild の性能値 | <https://esbuild.github.io/> |
| esbuild service.go（long-running / request id / callbacks） | <https://github.com/evanw/esbuild/blob/main/cmd/esbuild/service.go> |
| esbuild stdio_protocol.go（32-bit LE 長） | <https://github.com/evanw/esbuild/blob/main/cmd/esbuild/stdio_protocol.go> |
| sccache の CLI + daemon 構成 | <https://github.com/mozilla/sccache/blob/main/docs/Architecture.md> |
| sccache の idle 600 秒 | <https://github.com/mozilla/sccache/blob/main/src/server.rs> |
| sccache の設定（IDLE_TIMEOUT など） | <https://github.com/mozilla/sccache/blob/main/docs/Configuration.md> |
| sccache の client（retry / length-prefixed） | <https://github.com/mozilla/sccache/blob/main/src/client.rs> |
| sccache の IPC（TCP / UDS） | <https://github.com/mozilla/sccache/blob/main/src/net.rs> |
| tsserver の Content-Length / seq | <https://github.com/microsoft/TypeScript/wiki/Standalone-Server-(tsserver)> |
| gopls の再起動案内 | <https://go.dev/gopls/> |
| rust-analyzer が LSP サーバであること | <https://rust-analyzer.github.io/book/> |
| VS Code の watcher を UtilityProcess に置く理由 | <https://github.com/microsoft/vscode-wiki/blob/main/File-Watcher-Internals.md> |
| JetBrains VFS と native watcher process | <https://plugins.jetbrains.com/docs/intellij/virtual-file-system.html> |
| JetBrains の native file watcher | <https://blog.jetbrains.com/idea/2010/04/native-file-system-watcher-for-linux/> |
| openat2 の flags / Linux 5.6 / glibc wrapper なし | <https://man7.org/linux/man-pages/man2/openat2.2.html> |
| procfs の fd magic link | <https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html> |
| Go 1.24 の os.Root | <https://go.dev/doc/go1.24> |
| os.Root の API と制約 | <https://pkg.go.dev/os#Root> |
| Go の os.Root 実装（openat / fd / symlink 8） | <https://github.com/golang/go/blob/master/src/os/root.go> |
| Go の root_openat.go | <https://github.com/golang/go/blob/master/src/os/root_openat.go> |
| cap-std の openat2 / O_PATH / procfs | <https://github.com/bytecodealliance/cap-std> |
| libpathrs の resolver（openat2 / O_PATH / procfs） | <https://github.com/cyphar/libpathrs> |
| libpathrs の openat2 resolver | <https://github.com/cyphar/libpathrs/blob/main/src/resolvers/openat2.rs> |
| Landlock の制約（解除不可 / 子に継承） | <https://docs.kernel.org/userspace-api/landlock.html> |
| Node child_process の serialization / send | <https://nodejs.org/api/child_process.html> |
| Node worker_threads の特性 | <https://nodejs.org/api/worker_threads.html> |
| Node の v8 serialization | <https://nodejs.org/api/v8.html#serialization-api> |
| git の setup.c（chdir 探索） | <https://github.com/git/git/blob/master/setup.c> |
| git の entry.c（openat / renameat なし） | <https://github.com/git/git/blob/master/entry.c> |
| Bazel sandboxing（general） | <https://bazel.build/docs/sandboxing> |

### 8.2 推測（根拠付き。実装 / 再測で確定する）

- **write 全体が約 2.7 ms**。試作の helper 0.22 ms + checks 経路の 2.5 ms（0172 の実測）からの見積もり。journal の fsync の実際のコストは実装後に C3 で測る。
- **integration が 1–2 s**。churn test の 3053 ms が 21 write × 2 spawn × 74 ms と一致することからの見積もり。helper 以外のテスト時間（watcher、sandbox、R2 binding）は残る。
- **worker の初回 write が 10 ms 境界**。起動 p50 9.78 ms + fs。p95 は 11 ms を超えるので、目標を p95 で見ると不合格になり得る。
- **helper の RSS は 73 MB より少し大きい**。単純な stdio server の実測が 73 MB。実際は valibot と protocol を読み込む。
- **Bazel の worker crash 後の action 再試行**は実行戦略に依存する。invalidateAndClose はソースで確認したが、再試行回数は未確認。
- **VS Code の watcher が落ちたときの再起動**は実装依存。File-Watcher-Internals には再起動の詳細がない。
- **JetBrains の fsnotifier の再起動**は IDE が行うと推測。ドキュメントに明記はない。
- **Landlock は Linux 5.13 以降**（ABI v1）。カーネルドキュメントに導入バージョンの明記を確認できなかったため、一般知識として扱う。
- **Node の .ts helper を worker で動かす**場合、type stripping が worker でも効くかは未確認。効かなければビルドが要る。

### 8.3 未確認（追加調査）

- vscode-languageclient の maxRestartCount の既定値（ソースの型定義は確認したが、数値の既定は追い切れていない）。
- watchman daemon が最後のクライアント切断後に終了するか。ドキュメントは「ユーザーごとに 1 つの long-lived process」とだけ書く。idle_reap は watch 単位。
- Bazel の worker crash 時の再試行回数と、multiplex 中の 1 要求だけが失敗したときの他要求への影響。
- esbuild の service が落ちたときの JS API の自動再起動の有無（「service was stopped」エラーになることは確認）。
- openat2 の RESOLVE_BENEATH と /proc/self/fd の組み合わせ（RESOLVE_NO_MAGICLINKS を付けると /proc/self/fd が使えなくなること）の実機確認。
- Node 26 の worker 内での .ts type stripping。
- helper の実 RSS（valibot 込み）。
- open の実測内訳（どのテストが何回開くか）。今回は静的 count（openWorkspace 44 箇所）と integration の全体時間からの推定。

## 付録 A. 実測の生値（抜粋）

~~~json
{"host":{"platform":"linux","arch":"x64","cpu":"AMD Ryzen 9 7940HS w/ Radeon 780M Graphics","cores":16,"totalMemGB":60.6,"kernel":"6.18.59"}}
{"node26.13.0:spawn-empty":{"n":15,"min":30.1,"p50":33.86,"p95":39.73,"max":39.99,"mean":34}}
{"node26.13.0:spawn-print":{"n":15,"min":33.65,"p50":36.92,"p95":38.78,"max":42.44,"mean":37.09}}
{"node26.13.0:helper-probe":{"n":15,"min":72.22,"p50":74,"p95":75.79,"max":76.46,"mean":74.11}}
{"node26.13.0:stdio-startup":{"n":1,"min":36.45,"p50":36.45,"p95":36.45,"max":36.45,"mean":36.45}}
{"node26.13.0:stdio-rtt":{"n":20,"min":0.02,"p50":0.04,"p95":0.07,"max":0.07,"mean":0.04}}
{"node26.13.0:stdio-concurrent-8":{"n":10,"min":0.05,"p50":0.07,"p95":0.08,"max":0.27,"mean":0.08}}
{"node26.13.0:stdio-big-1MiB":{"n":10,"min":2.64,"p50":4.1,"p95":6.53,"max":6.59,"mean":4.56}}
{"node26.13.0:stdio-child-rss-MB":73.078125}
{"node26.13.0:kill-detect":4.2}
{"node26.13.0:restart-to-ready":34.71}
{"node26.13.0:ipc-rtt":{"n":20,"min":0.01,"p50":0.03,"p95":0.21,"max":0.26,"mean":0.06}}
{"node26.13.0:ipc-big-1MiB":{"n":10,"min":1.69,"p50":3.54,"p95":4.15,"max":4.45,"mean":3.23}}
{"node26.13.0:worker-startup-eval":{"n":15,"min":8.91,"p50":9.78,"p95":10.98,"max":11.15,"mean":9.95}}
{"node26.13.0:worker-startup-file":{"n":15,"min":8.67,"p50":9.52,"p95":10.33,"max":11.54,"mean":9.66}}
{"node26.13.0:worker-rtt":{"n":20,"min":0.01,"p50":0.02,"p95":0.02,"max":0.03,"mean":0.02}}
{"node26.13.0:worker-big-1MiB":{"n":10,"min":0.33,"p50":0.35,"p95":0.46,"max":0.67,"mean":0.39}}
{"node26.13.0:worker-rss-delta-MB":12}
{"node24.22.2:spawn-empty":{"n":15,"min":18.56,"p50":20.82,"p95":22.74,"max":23.3,"mean":20.92}}
{"node24.22.2:helper-probe":{"n":15,"min":60.02,"p50":65.48,"p95":67.64,"max":69.43,"mean":65.42}}
{"node24.22.2:worker-startup-eval":{"n":15,"min":8.2,"p50":9.28,"p95":9.88,"max":10.06,"mean":9.25}}
{"node24.22.2:stdio-child-rss-MB":66.43359375}
{"node24.22.2:worker-rss-delta-MB":11.5}
~~~

~~~json
{"CURRENT_HASH_COMMIT_2SPAWN":{"n":15,"min":148.4,"p50":150.67,"p95":154.21,"max":154.36}}
{"PERSISTENT_SPAWN_TO_READY":38.19}
{"PERSISTENT_HASH_COMMIT_2RPC":{"n":30,"min":0.16,"p50":0.22,"p95":0.45,"max":0.81}}
{"ENV_EXEC_HELPER_PROBE":{"n":15,"min":71.43,"p50":73.6,"p95":77.06,"max":79.03}}
{"HELPER_NOARG_TS":{"p50":74.5,"p95":77.18,"n":15}}
{"HELPER_NOARG_JS":{"p50":43.51,"p95":45.76,"n":15}}
{"STDIO_BIG_8MiB_FAIR":{"n":10,"p50":21.94,"p95":35.52,"min":21.17,"max":38.04}}
{"IPC_BIG_8MiB":{"n":10,"p50":26.95,"p95":31.75,"min":24.26,"max":34.17}}
{"WORKER_BIG_8MiB":{"n":10,"p50":2.86,"p95":3.09,"min":2.59,"max":19.82}}
{"JSON_PARSE_11MB":{"n":10,"p50":6.53,"p95":7.01,"min":3.25,"max":11.19}}
{"ONESHOT_HELPER_READ_8MiB":{"n":10,"p50":103.4,"p95":106.54,"min":99.94,"max":106.64}}
~~~

## 付録 B. 再現コマンド

~~~bash
# Node のバージョン
nix develop --command node --version   # この環境では ~/.cache/nix が read-only で失敗
/nix/store/ywwchijlngjj756gqp3izz8xw6q8cca2-nodejs-26.13.0/bin/node --version

# integration の基準値（repo の root で）
NODE26=/nix/store/ywwchijlngjj756gqp3izz8xw6q8cca2-nodejs-26.13.0/bin/node
"$NODE26" node_modules/vitest/vitest.mjs run --project workspace-integration --reporter=verbose

# Node の spawn / IPC / worker / big payload
# bench.mjs は /tmp に置いた。BENCH_N=15、BENCH_NODES に Node 26 と 24 を渡す。
BENCH_N=15 BENCH_NODES="$NODE26,/run/current-system/sw/bin/node" "$NODE26" bench.mjs

# 常駐 helper の試作（hash + commit の 2 RPC）
"$NODE26" measure.mjs
~~~

試作の要点（/tmp に置いた code。repo には入れていない）:

~~~js
// server: root の dirfd を 1 回だけ開いて保持する
const root = await open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
const fdp = (fd, name) => "/proc/self/fd/" + fd + "/" + name;
// hash: open(fdp(root.fd, name)) を読んで sha256
// commit: 再ハッシュ → expected と比較 → rename(fdp(root.fd, temp), fdp(root.fd, name))
// 応答は 1 行 JSON。client は id で pending を対応付ける。
~~~

## 付録 C. 0191 の U-01〜U-05 との対応

| 0191 の未確定 | この調査の結論 | 推奨 |
| --- | --- | --- |
| U-01 child か worker か | child。worker は次点 | R1 |
| U-02 port の形 | spawn だけの小さな port。ExecutionEnv は変えない | R2 |
| U-03 crash | 1 回再起動、60 秒 3 回で fail closed。checks へ落とさない | R3 |
| U-04 idle / close | idle 60 秒、close で必ず閉じる、timer は unref | R4 |
| U-05 テストの helper 再利用 | まず per-Workspace。3 秒を超えたら root キーの test pool | R5 |



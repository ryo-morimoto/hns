# sandbox のプラットフォーム別実測と候補

2026-11-07。Linux は実測（bubblewrap 0.12.0 / NixOS / kernel 6.18）。macOS と Windows は文献調査のみで、実機は無い。

## 結論

- Linux は bubblewrap を前提にする。検出は「PATH か `BWRAP` に実行可能な bwrap がある」→「`--version` が読める」→「wrapper と同じ引数で 1 回動く」の順。user namespace は最後の実実行で判定する。
- 非 Linux は exec を出さない（fail closed）。macOS の `sandbox-exec` は deprecated で profile 言語が非公開、Windows の AppContainer は native helper が要る。実機で確かめられないうちは実装しない（D032）。
- 非 Linux の代替は 0033/0040 で再検討する。macOS は sandbox-exec（短期）か App Sandbox + helper（配布時）、Windows は WSL2 上の Linux サーバか AppContainer helper。

## Linux（実測）

| 確認 | 落ち方 | 実測 |
| --- | --- | --- |
| bwrap の所在 | PATH と `BWRAP` を見る。`which` は使わない | NixOS では PATH 上の bwrap を解決できた |
| バージョン | `bwrap --version` → `0.12.0` | 表示は `bubblewrap 0.12.0` |
| user namespace | `--ro-bind / /` だけでは不十分。wrapper と同じ full 引数で probe | `/proc/sys/user/max_user_namespaces=2147483647`、probe 成功 |
| shell | `/bin/sh` が無い環境がある | NixOS は `/bin/true` が無い。旧 probe はこれで誤って「userns 不可」と判定した |

- 使う引数: `--die-with-parent --ro-bind / / --bind <root> <root> --dev /dev --proc /proc [--tmpfs /tmp] --unshare-pid --unshare-ipc --unshare-uts --chdir <cwd> -- <shell> -c ...`。root が `/tmp` 配下のときは `--tmpfs /tmp` を付けない（root が隠れるため）。
- ネットワークは切らない（D005 の範囲では Agent のビルド・取得を許す）。切るなら `--unshare-net` を足すだけで済む。
- bubblewrap 自体は「完成した sandbox」ではなく、引数が方針そのもの（README の "Sandbox security"）。弱い引数に変えると封じ込めは消えるので、wrapper は 1 箇所に閉じる。
- 代替: Landlock（5.13+、path 単位の read/write。network は ABI v4 / 6.7 以降）、seccomp（path は見られない）、`unshare`/`nsjail`、コンテナ。bwrap を残す理由は「root 不要・mount namespace・uid map・実績」。Landlock は bwrap が使えないカーネル向けの第 2 候補になり得るが、read-only bind の再現に自前コードが要る。

## macOS（文献）

- `sandbox-exec(1)` は **DEPRECATED**（man page、2017）。`-p` で profile 文字列、`-f` でファイル。profile 言語は非公開で、互換性の保証が無い。
- `sandbox(7)`: 子プロセスは親の sandbox を継承する。制限は資源の取得時に効くので、既に開いた fd は制限後も使える。
- App Sandbox は entitlement ベースで、署名済みアプリが対象。helper tool を同梱して継承させることはできるが、任意の workspace パスへの読み書きは security-scoped bookmark かユーザー選択に寄る。サーバとして任意パスを開く用途には合いにくい。
- `sandbox-exec` で書くなら、概形は次のとおり。ただし `deny default` は dyld・`/private/tmp`・`~/Library` のキャッシュを壊すので、allow を足しながらでないと動かない。

```scheme
(version 1)
(deny default)
(allow file-read*)
(allow process-exec process-fork)
(allow file-write* (subpath "/path/to/root"))
(allow network*)
```

- 未確認: 最新の macOS に `sandbox-exec` が残っているか、symlink 経由の書き込みを path filter がどう解決するか、`--tmpfs` 相当をどこに置くか。
- 判断: 実機が無いので実装しない。実装するなら bwrap と同じ検出契約（root 内に書ける / root 外に書けない / 外を読める）を probe にし、backend を差し替える。

## Windows（文献）

- AppContainer は profile（`CreateAppContainerProfile`）と token（`CreateProcessAsUser`）を作って子プロセスを起動する。ファイルとレジストリは SID の ACL、ネットワークは capability で許可する。Node から直接は扱えず、Rust/C の helper が要る。
- Job object は CPU・メモリ・プロセスの制限で、ファイルの封じ込めではない。
- Windows Sandbox は VM（Pro/Enterprise）。1 コマンドごとの sandbox には重い。
- WSL2 は現実的: Linux 側でサーバを動かし、その中で bwrap を使う。workspace を `/mnt/c` に置くとパーミッションと大文字小文字の差が出るので ext4 側に置く。
- 判断: native Windows は exec を出さない。WSL2 対応は「WSL 内でサーバを動かす」であって、`wsl.exe` を毎回 exec することではない。

## 出所

| 内容 | URL |
| --- | --- |
| bubblewrap README（user namespace / sandbox security） | <https://github.com/containers/bubblewrap> |
| bwrap(1) man page（引数） | <https://github.com/containers/bubblewrap/blob/main/bwrap.xml> |
| sandbox-exec(1) man page（DEPRECATED） | <https://keith.github.io/xcode-man-pages/sandbox-exec.1.html> |
| sandbox(7) man page（継承・fd） | <https://keith.github.io/xcode-man-pages/sandbox.7.html> |
| Apple App Sandbox | <https://developer.apple.com/documentation/security/app-sandbox> |
| Apple: サンドボックスアプリへの helper tool 同梱 | <https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app> |
| Microsoft: AppContainer isolation | <https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation> |
| Microsoft: AppContainer for legacy apps | <https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-> |
| Linux Landlock | <https://docs.kernel.org/userspace-api/landlock.html> |

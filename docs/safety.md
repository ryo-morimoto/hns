# 安全

2026-11-07 / 要件18。ここまでの検証で塞いだ穴と、残っている穴。

## 塞いだ

| 穴                                                | 対応                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exec が root の外に出る                           | bubblewrap で root だけ書き込み可（`createSandboxEnv`）                                                                                                         |
| sandbox が無い環境で exec が野放し                | 起動時に検出し、使えなければ **bash を登録しない**（fail closed）。tool ノードも `createNoExecEnv` が拒否する。`/api/health` に理由                             |
| bwrap の検出を誤る                                | `/bin/true` 固定をやめ、shell を解決して wrapper と同じ引数で probe。NixOS でも正しく有効化できる                                                               |
| root の差し替え                                   | Journal の ID と root 内の marker を照合。欠落・不一致は開かない                                                                                                |
| パス脱出                                          | 正規化 + canonical 化。symlink 脱出を拒否                                                                                                                       |
| `.git` の改変                                     | `Workspace` が書き込みを拒否（読み取りは可）                                                                                                                    |
| rename 中の親差し替え（dirfd 経路）               | dirfd 相対で open / rename する。`checks` 経路は再確認のみで窓が残る（下記）                                                                                    |
| 復旧コードの総当たり                              | 同一 login で 5 回失敗したら 15 分 429                                                                                                                          |
| SSH の事故                                        | pi-env の `sshArguments` を検査: `-T -a -x`、`BatchMode=yes`、転送なし、ホスト鍵は自前ファイルに厳格                                                            |
| 操作 ID で root の外に書く                        | workspace は temp 名を内部生成の UUID にし、`operationId` をパスに使わない（HTTP の境界は core の schema が `[A-Za-z0-9_-]{1,64}` に限定）。規則は1箇所だけ持つ |
| agent の bash にサーバの env（鍵・token）が漏れる | sandbox で `--clearenv`。`PATH` と `HOME`（root）などだけを `--setenv` で戻す                                                                                   |
| agent の bash から鍵ファイルが読める              | `createSandboxEnv({ hide })` が指定ディレクトリを tmpfs で隠す（呼び出し側が `~/.config/hns` を渡す）                                                           |
| watcher がディレクトリ作成で落ちる                | `is_directory` はイベント対象外にし、未知の失敗は `overflow` に落とす。`void` の reject も必ず処理する                                                          |

## 残っている

| 穴                              | 影響                                                                                           | 次の手                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TOCTOU の最終窓（dirfd）        | 同名ファイルを hash と rename の間に差し替える窓が残る。lost update のみで root の外には出ない | v0.1 は許容（0054）。閉じるのは `renameat2` を出せる native helper の導入時（配布は 0040）                                                  |
| machine の TOCTOU（親の差し替え） | 同一ユーザーが検証と open の間に親を差し替えると、ROOT 外を読める・一覧できる。ROOT 外に書く経路は無い（書き込み op が無い） | 0147 は同一ユーザーを信頼境界にしない。dirfd helper を machine にも配線する（0194 / 0054） |
| TOCTOU の親の窓（`checks`）     | ヘルパーを実行できない環境では、親の差し替えで root の外に書き・読める（再確認のみで窓が残る） | v0.1 は helper 任意のため許容（保証表の「破れる条件」）。閉じるのは `rooted: "required"` を既定にするか、配布で helper を確実にする（0040） |
| SSH の実接続                    | フラグは検証したが、実サーバとの接続は未検証                                                   | 2台目が用意できたら 1 回通す                                                                                                                |
| 非 Linux と bwrap 未導入        | exec を出せない（封じ込めなしでは動かさない）                                                  | 検出は 0006 で完了。macOS / Windows の backend と配布は 0033 / 0040（[調査](../work/research/sandbox-platforms.md)）                        |
| DEK の露出                      | unlocked 中は `/api/passkey/dek` が DEK を返す。XSS で破れる                                   | CSP、入力の扱い                                                                                                                             |
| root 内の `.hns` / `.hns-tmp-*` | agent から見える                                                                               | 制御用ディレクトリへ退避                                                                                                                    |
| 監査の改ざん                    | Journal は同じプロセスが書く                                                                   | 追記専用ログの外部化（必要になったら）                                                                                                      |
# 安全

2026-11-07 / 要件18。ここまでの検証で塞いだ穴と、残っている穴。

## 塞いだ

| 穴 | 対応 |
| --- | --- |
| exec が root の外に出る | bubblewrap で root だけ書き込み可（`createSandboxEnv`） |
| sandbox が無い環境で exec が野放し | 起動時に検出し、使えなければ **bash を登録しない**（fail closed）。tool ノードも `createNoExecEnv` が拒否する。`/api/health` に理由 |
| bwrap の検出を誤る | `/bin/true` 固定をやめ、shell を解決して wrapper と同じ引数で probe。NixOS でも正しく有効化できる |
| root の差し替え | Journal の ID と root 内の marker を照合。欠落・不一致は開かない |
| パス脱出 | 正規化 + canonical 化。symlink 脱出を拒否 |
| `.git` の改変 | `Workspace` が書き込みを拒否（読み取りは可） |
| rename 中の親差し替え | rename 直前に親を再確認し、後にも canonical を再確認。外れていれば `unknown` |
| 復旧コードの総当たり | 同一 login で 5 回失敗したら 15 分 429 |
| SSH の事故 | pi-env の `sshArguments` を検査: `-T -a -x`、`BatchMode=yes`、転送なし、ホスト鍵は自前ファイルに厳格 |

## 残っている

| 穴 | 影響 | 次の手 |
| --- | --- | --- |
| TOCTOU の最終窓 | 再確認と `rename` の間に親を差し替えられると理論上は外に出る | `openat2(RESOLVE_BENEATH)` / dirfd が要る（0005） |
| SSH の実接続 | フラグは検証したが、実サーバとの接続は未検証 | 2台目が用意できたら 1 回通す |
| 非 Linux と bwrap 未導入 | exec を出せない（封じ込めなしでは動かさない） | 検出は 0006 で完了。macOS / Windows の backend と配布は 0033 / 0040（[調査](../work/research/sandbox-platforms.md)） |
| DEK の露出 | unlocked 中は `/api/passkey/dek` が DEK を返す。XSS で破れる | CSP、入力の扱い |
| root 内の `.hns` / `.hns-tmp-*` | agent から見える | 制御用ディレクトリへ退避 |
| 監査の改ざん | Journal は同じプロセスが書く | 追記専用ログの外部化（必要になったら） |

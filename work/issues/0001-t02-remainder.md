# 0001: T-02 の残り

status: done
depends-on: -
touches: work/poc/root-containment, work/poc/root-swap, docs/workspace.md

## Goal

Root 封じ込めを「読める/拒否できる」から「監査できて、Worker 越しでも同じ」にする。
traversal と symlink 脱出は 7/7 で拒否済み（`work/poc/root-containment`）。

## Acceptance criteria

- [x] 拒否が operationId 付きで監査ログに残る
- [x] Root を rename / 差し替えした最中の read/write の挙動を記録
- [x] RemoteExecutionEnv 越しでも同じ 7 ケースが通る（SSH以外）
- [x] TOCTOU の残余を契約 §認可§ に追記

## Log

- 2026-11-06: 作成。
- 2026-11-06: 監査ログ、root 差し替え、RemoteExecutionEnv を実装・検証。

## Result

- `Workspace` が拒否を `audit`（operationId・path・reason）に残す。HTTP では 403。
- root は操作ごとに存在確認。rename 後は denied になり、書き込みで再作成しない。
- root の replace は Journal の id と `.hns/root.json` で検出（open で拒否）。symlink の差し替えは開いた時点の解決結果に固定。
- 残る TOCTOU は 0005、bwrap の前提は 0006。
- 封じ込めは node / daemon / RemoteExecutionEnv の3経路で 21/21。
- 残り: SSH 越しの RemoteExecutionEnv（この環境に sshd がない）、`.git/` 書き込み拒否、監査の永続化形式。
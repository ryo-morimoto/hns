# 0164: バックアップと復元の運用（0020 の再定義）

status: open
priority: next
design: pending
depends-on: 0154
touches: docs/backup.md, deploy/backup/

## Goal

0020 のバックアップを、Cloudflare 上の正本に合わせて作り直す。復元を「練習済みの手順」にする。

## Acceptance criteria

- [ ] 対象の棚卸し（DO SQLite / R2 / D1 / マシンの .git / 設定）
- [ ] R2 の versioning と object lock、別アカウントへの複製の要否
- [ ] DO の SQLite をどう退避するか（export / 再構築の可否）
- [ ] 復元の runbook と、四半期に一度の演習
- [ ] 「戻せないもの」を明記（checkpoint 以降の agent 変更、会話の一部）

## Notes

- D015（VACUUM INTO、停止中に復元）はローカル DB の話。Cloudflare では置き換わる。
- 11 nines は「オブジェクトが壊れない」であって「戻せる」ではない。

## やらないこと

- 別リージョンへの自動フェイルオーバー。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

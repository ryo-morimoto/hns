# 0020: バックアップと復元（要件16）

> 前提変更: Cloudflare 上の正本に合わせて 0164 で作り直す。D015 はローカル DB の話として残す。

status: done
depends-on: 0014
touches: work/poc/app

## Goal

状態を丸ごと退避し、戻せるようにする。スキーマ変更の足場も置く。

## Acceptance criteria

- [x] 動いている状態で一貫したバックアップが取れる
- [x] 復元で Project / Task / 会話 / ファイルが戻る
- [x] スキーマ版を持つ（migration の足場）

## Result

- `backup.mjs`: SQLite は `VACUUM INTO`（開いたまま取れる一貫スナップショット）、`journal.json` と `token` はコピー。
- 復元はアプリ停止中に `--restore`。`-wal` / `-shm` も片付ける。
- `control.sqlite` は `PRAGMA user_version` を持つ（今は 1）。`session.sqlite` は Durable の管理。
- 残り: 定期バックアップ、復元の定期訓練、保持期間。

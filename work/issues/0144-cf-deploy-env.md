# 0144: 配備と環境（cf CLI・cloudflare.config.ts・秘密の投入）

status: done
priority: now
depends-on: 0140
touches: tools/deploy/, tools/gate/stages.ts, tools/gate/test/stages.test.ts, vitest.config.ts, package.json, package-lock.json, .gitignore, docs/engineering.md, docs/decisions.md, work/issues/0144, work/issues/0145, work/LANES.md

## Goal

製品の Worker を `cf` で配備できるようにし、dev / stg / prod の分け方と秘密の入れ方を固定する。

## Acceptance criteria

- [x] `cloudflare.config.ts` をリポジトリで持ち、`wrangler.toml` を持たない
- [x] Durable Object は `exports.durableObject({ storage: "sqlite" })` で宣言
- [x] 環境ごとの Worker 名・var・secret の対応表（dev はローカル、stg / prod は別 Worker）
- [x] 秘密は `cf deploy --secrets-file` か Secrets Store のどちらか一方に統一し、リポジトリに置かない
- [x] ロールバック手順（version を戻す）と、DO の SQLite が戻らないことを明記
- [x] `cf deploy --dry-run` をチェックに入れる

## テスト条件

- C1: deploymentFor が development / staging / production を正しい Worker 名・URL・model に写像する。
- C2: cf deploy --dry-run --mode development が認証なしで成功する。
- C3: staging / production は https URL と model を欠落時に拒否する。
- C4: deploy stage が pre-push / --all にだけ入り、pre-commit には入らない。
- C5: 秘密がリポジトリに入らず、rollback と DO SQLite の非復元が docs にある。

## テスト設計

- T1: tools/deploy/config.test.ts の unit（C1 / C3）。
- T2: ゲートの deploy stage と tools/gate/test/stages.test.ts（C2 / C4）。
- T3: ダミー env での手動 dry-run（C3）。
- T4: tools/deploy/deploy.sh の条件確認と docs review（C5）。

## Notes

- 設定は `tools/deploy/cloudflare.config.ts`。cf は npm workspace の root を拒否するため、tools/deploy を project root にする。
- 環境は cf の modes（development / staging / production）で切る。
- 0145 までの一時 entrypoint は `tools/deploy/worker.ts`。0145 が packages/server/src/edge/worker.ts の re-export に差し替える。
- `cf deploy --dry-run` は認証もアップロードも不要。ゲートでは `--mode development` を使う。
- 秘密は `cf deploy --secrets-file`。staging / production は `~/.config/hns/<mode>.secrets.json`（0600、JSON）。
- バンドルは PoC で 897KB / gzip 204KB、startup 6ms。

## やらないこと

- CI（0041）。
- 独自ドメインとゾーン（0160）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-11: 実装開始。cf / wrangler を exact pin し、modes で進める。
  cf は npm workspace の root を project として扱わないため、config ごと tools/deploy/ に置く。
- 2026-11-11: cf@1.0.0-beta.28 / wrangler@4.156.0 を tools/deploy に。root の npm install から
  postinstall で tools/deploy を install する。
- 2026-11-11: tools/deploy で cf deploy --dry-run --mode development 成功（約0.9s、認証不要）。
  staging も成功（hns-stg）。npm run check 成功（182 tests / build / knip）。
- 2026-11-11: reviewer-0144 が **FAIL**（blocking 3）。--mode 未指定が production に落ちる、rollback の引数、
  0145 / LANES のパスが実ファイルと違う。修正: --mode を必須にし docs を更新、rollback を
  --worker-id / --message 無しに、handoff / ledger を tools/deploy に。secret のキー whitelist も追加。
- 2026-11-11: reviewer-0144 が **PASS**（blocking 0）。残る low は Result に記録。

## Result

- verdict: **PASS**（初回 FAIL 3 → 修正 → 再レビュー PASS）
- reviewer: reviewer-0144
- HEAD: 86f9c96（review 時 648730a。main へ rebase 後）
- blocking: なし
- 受入: 6/6。`npm run check` 成功（182 tests / build / knip / deploy dry-run 918ms）。
- non-blocking:
  - 低 / `docs/engineering.md:119-121` / rollback は repo root で実行する（tools/deploy では mode 必須で止まる）。
  - 低 / `tools/deploy/package.json` / cf は root の devDependency。standalone の npm ci では config の cf/config が解決しない。
  - 低 / `package.json:16` / deploy:check と deploy stage が同じコマンドを二重に持つ。deploy.sh の whitelist にテストなし。
  - 低 / `tools/deploy/cloudflare.config.ts:40` / @remarks に「mode は必須」を追記する。
  - 低 / `AGENTS.md:39` / 本文の stage 説明に deploy を追加する。
  - 低 / `tools/deploy/deploy.sh` / キー名のみ検査。値の型・空文字は未検査。
- 未確認: 実アカウントの cf deploy --secrets-file / staging / production / rollback。DO SQLite の非復元の実挙動。
  fresh clone の npm install → postinstall。prek 経由の pre-push。
- main への統合は他レーンの作業が終わってから（branch issue/0144-deploy）。

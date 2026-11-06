# 0004: 開発環境の固定

status: done
depends-on: -
touches: README.md, flake.nix, flake.lock, scripts/with-node.sh, work/poc/install.sh

## Goal

このマシンは `node` が PATH に無く、nix store のバイナリを直接使っている（U-14）。
再現できる開発環境を固定する。

## Acceptance criteria

- [x] `node` の版（22.19+ / 24.x）と入手方法を決める
- [x] `npm install` と PoC がクリーンな環境で再現する
- [x] README の「再実行」がその手順になる

## Result

- Node は **24.x**（nixpkgs `nixos-25.11` の `nodejs_24`、いまは 24.18.0 / npm 11.16.0）。
  `flake.nix` と `flake.lock` で nixpkgs の rev まで固定（D032）。
- `scripts/with-node.sh` は `nix develop` 経由で同じ Node を実行する。`/nix/store` の glob は廃止。
- `work/poc/install.sh` で PoC の依存をまとめて入れる（`app` は隣の `workspace-core`・`conversation` を import する）。
- クリーンな HOME・npm キャッシュ・空のツリーから `npm install` → `npm run check`、
  `work/poc/install.sh` → `app/run.mjs`（12/12）・`walking-skeleton/run.mjs`（13/13）を確認。
- CI で回すのは 0041。

## Log

- 2026-11-06: 作成。当面は `/nix/store/…-nodejs-24.15.0/bin/node` を直接使用。
- 2026-11-07: 決定と実装。`flake.nix` / `flake.lock`、`with-node.sh` の差し替え、README・AGENTS・engineering・decisions（D032）を更新。
- 2026-11-07: クリーン環境で再現を確認して done。

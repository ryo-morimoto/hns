# 0004: 開発環境の固定

status: open
depends-on: -
touches: README.md, work/poc/

## Goal

このマシンは `node` が PATH に無く、nix store のバイナリを直接使っている（U-14）。
再現できる開発環境を固定する。

## Acceptance criteria

- [ ] `node` の版（22.19+ / 24.x）と入手方法を決める
- [ ] `npm install` と PoC がクリーンな環境で再現する
- [ ] README の「再実行」がその手順になる

## Log

- 2026-11-06: 作成。当面は `/nix/store/…-nodejs-24.15.0/bin/node` を直接使用。
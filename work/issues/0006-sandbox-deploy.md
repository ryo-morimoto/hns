# 0006: sandbox の前提を固める

status: open
depends-on: -
touches: work/poc/sandbox, docs/workspace.md

## Goal

`createSandboxEnv` は bubblewrap と Linux に依存している。どのマシンで使えるかを検出し、
使えないときに何をするか（exec を提供しない / 警告 / 制限付きで提供）を決める。

## Acceptance criteria

- [ ] 起動時に bwrap の有無・バージョン・user namespace の可否を検出
- [ ] 使えないマシンでは exec を無効化（または明確に制限）し、状態として見せる
- [ ] macOS / Windows の代替（sandbox-exec / AppContainer）を調べる

## Log

- 2026-11-06: 作成。検証は Linux + bubblewrap 0.12.0 のみ。

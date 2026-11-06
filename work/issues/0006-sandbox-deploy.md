# 0006: sandbox の前提を固める

status: done
depends-on: -
touches: work/poc/sandbox, work/poc/workspace-core, work/poc/app, work/research/sandbox-platforms.md, docs/workspace.md

## Goal

`createSandboxEnv` は bubblewrap と Linux に依存している。どのマシンで使えるかを検出し、
使えないときに何をするか（exec を提供しない / 警告 / 制限付きで提供）を決める。

## Acceptance criteria

- [x] 起動時に bwrap の有無・バージョン・user namespace の可否を検出
- [x] 使えないマシンでは exec を無効化（または明確に制限）し、状態として見せる
- [x] macOS / Windows の代替（sandbox-exec / AppContainer）を調べる

## Log

- 2026-11-06: 作成。検証は Linux + bubblewrap 0.12.0 のみ。
- 2026-11-07: 検出を再実装。`/bin/true` 固定の probe が NixOS で誤判定していたのを直し、shell の解決と wrapper と同じ引数の実実行に変えた。バージョン・PATH 解決・sysctl・失敗 code を返す。
- 2026-11-07: 使えないときは `createNoExecEnv` で exec を拒否。bash ツールだけでなくワークフローの tool ノードも止める。`/api/health` と `server.start` に状態を出す。
- 2026-11-07: `BWRAP` の既定を PATH の `bwrap` にし、PoC 各所の nix store 直書きをやめた。

## Result

- `detectSandbox()` が `{ available, exec, backend, platform, bwrap, version, shell, userNamespaces, sysctls, code, reason, checkedAt }` を返す。判定は「Linux か → bwrap の所在 → バージョン → wrapper と同じ 1 回の実行」の順。
- 失敗 code: `unsupported-platform` / `not-found` / `not-executable` / `version-failed` / `userns-unavailable` / `shell-missing` / `smoke-test-failed`。
- `work/poc/sandbox` **18/18**: 検出（有効・欠落・非実行・偽物）と封じ込め（root 内書き込み、親 / home 拒否、argv、exit code、file API）。bwrap が無い環境は封じ込めを SKIP。
- `work/poc/app/run-safety.mjs` **15/15**: 検出の状態、health の `exec: "disabled"`、sandbox 無しで tool ノードが書かずに失敗することを追加。
- 非 Linux は exec を出さない（D033）。macOS は sandbox-exec（deprecated・profile 非公開）と App Sandbox + helper、Windows は AppContainer helper と WSL2 を比較し、実機が無いため実装しない。詳細は [sandbox-platforms.md](../research/sandbox-platforms.md)。

## 残り

- macOS / Windows の backend は実機が用意できたら（0033 / 0040）。
- bwrap の同梱・導入案内は配布（0040）。Landlock は bwrap が使えないカーネル向けの第 2 候補。

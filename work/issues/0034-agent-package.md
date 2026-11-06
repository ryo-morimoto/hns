# 0034: agent パッケージ（移植）

status: done
depends-on: 0033
touches: packages/agent

## Goal

Durable の組み立て・ツール・hooks・プロバイダを packages/agent に移す。

## Acceptance criteria

- [x] Harness / conversation / resume を移す
- [x] read_file / write_file / bash と観測 hooks を移す
- [x] Ollama / OpenCode アダプタを移す
- [x] faux の統合テストが通る

## Log

- 2026-11-07: 作成。
- 2026-11-07: `packages/agent` を作り、Harness の組み立て・Workspace ツール・観測・2 プロバイダを移植した。
  設計は D037（失敗は値、`ShellAccess` で bash の有無を型に、依存は `openAgent()` だけ）。

## Result

- `openAgent({ storage, models, workspace, shell, model, cwd, context, onEvent })` が Harness と conversation を 1 箇所で組み立てる。
  `send()` は submission を待ち、settlement と返答テキストを返す。`transcript()`、`close()`、`tools`。
- ツール: `read_file` / `write_file` は Workspace の版チェックを通し、拒否は `{ok:false, status, message}` の値で返す
  （run は落とさない）。`bash` は `shell.kind === "sandboxed"` のときだけ登録する。
- 観測: `tool.call` / `tool.result`（ok・ms）/ `agent.response` を `onEvent` に流す。名前は core の `EventName` と揃えてある。
- プロバイダ: `ollamaCloud()` / `opencodeGo()`。鍵は env → `~/.config/hns` → `.work` の順（`readKey`、テストは `fixedKeySource`）。
- 試験: `test/agent.test.ts` 6（faux + 実 Workspace + 実 Harness。sandbox は bwrap があれば実物）、`test/keys.test.ts` 6。**12/12**。
  conflict / denied が値としてモデルに届くこと、bash が無い環境ではツールを出さないことを固定した。

## 残り

- 再起動をまたぐ resume は永続 storage が要る。`Storage` は注入点なので、store/HTTP（0035）で SQLite 実装を差す。
- 実プロバイダ（Ollama Cloud / OpenCode Go）の疎通は PoC の `work/poc/conversation/real.mjs` で確認済み。製品側の E2E は 0043。
- 観測イベントの永続化（`Event` への変換）は 0039。

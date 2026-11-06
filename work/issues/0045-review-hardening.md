# 0045: レビュー指摘の修正（workspace / core）

status: done
depends-on: 0004, 0033, 0037
touches: packages/workspace, packages/core, docs/safety.md, docs/workspace.md

## Goal

コードレビューで見つかった重大・高・中の指摘を直し、同じ穴が戻らないように
スキーマ・型・テストで固定する。

## Acceptance criteria

- [x] 重大: `operationId` で root の外に書ける
- [x] 重大: watcher がディレクトリ作成で unhandled rejection になる
- [x] 高: agent の bash にサーバの env が漏れる
- [x] 高: `createNoExecEnv` が `Result` ではなく reject する
- [x] 高: `FileError` が `FileFailure` に写像されず tool が defect になる
- [x] 中: GET の query schema が wire の文字列と合わない
- [x] 中: Journal の保存が非原子・非直列
- [x] 中: conflict の outcome が残らず、再送で後から適用されうる
- [x] 中: TOCTOU の説明が実装より強い

## Result

- **C-1**: `operationId` は `[A-Za-z0-9_-]{1,64}` のトークン（core schema + workspace の二重チェック）。
  temp 名は内部生成の UUID にし、呼び出し側の文字列をパスに使わない。回帰テストは
  `packages/workspace/test/hardening.test.ts`（hostile id で外に何も出ない、journal の temp に id が無い）。
- **C-2**: `is_directory` はイベント対象外、未知の失敗は `overflow`。`void` の reject を必ず処理。
  回帰テストは watcher 中に `mkdir` して unhandled rejection が無いこと。
- **H-1**: sandbox が `--clearenv` で env を落とし、`PATH`・`HOME`（root）などだけを戻す。
  `SandboxOptions.hide` で鍵ディレクトリを tmpfs に隠せる。bwrap 実機のテスト付き。
- **H-2**: `createNoExecEnv` は `err(new ExecutionError("shell_unavailable", ...))` を返す（reject しない）。
- **H-3**: `asFileFailure` を一箇所に置き、`FileError` を `FileFailure` に写像。ディレクトリ読取の回帰テスト付き。
- **M-1**: query schema を wire の文字列（`"1"` / `"50"`）に合わせ、`searchParamsObject` を追加。
- **M-2**: Journal は temp + flush + rename で原子的に置換し、`#save` を promise チェーンで直列化。
  並行 write の回帰テスト付き。
- **M-3**: 初回・dirfd・checks の conflict をすべて outcome として記録。再送しても適用されない回帰テスト付き。
- **M-4**: docs/workspace.md と docs/safety.md を実装に合わせて修正（同名ファイルの差し替え窓は残る）。

## Log

- 2026-11-07: レビュー（C-1〜M-4）を受けて修正。テストは各パッケージの `test/` に追加。

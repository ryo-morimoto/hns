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

- **C-1**: temp 名を内部生成の UUID にし、`operationId` をパスに使わない（構造で解く）。
  HTTP の境界は core の `OperationIdSchema` がトークンに限定するが、workspace 側に同じ規則は置かない
  （二重の規則は持たない）。回帰テストは `packages/workspace/test/hardening.test.ts` の 1 ケースで、
  hostile な id でも外に出ないことと temp 名に id が混ざらないことを固定する。
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
- 2026-11-07: 再レビュー。workspace 側の重複した operationId 規則と未使用 helper（`searchParamsObject`）を削除。
  境界は HTTP の schema 1箇所、封じ込めは temp の内部生成で担保する。重複していた回帰テストも統合した。
- 2026-11-07: 残りを [0052](0052-sandbox-hide-wiring.md)〜[0055](0055-journal-save-batching.md) に切った。
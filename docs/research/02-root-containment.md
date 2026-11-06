# Root 封じ込めの先行検証（T-02 の部分）

- 更新日: 2026-11-06
- 種別: 調査・検証記録（時点記録）
- 関連: [契約 v0.1 §6](../design/workspace-execution-contract-v0.1.md)、INV-02、T-02

## 何を確かめたか

`WorkspaceFileApi` の手前で、`ExecutionEnv` の `canonicalPath` を使って **Root の外へ出さない**解決が
成立するか。T-02 のうち、パス正規化と symlink 脱出だけを先に試した。

## 方法

`poc/root-containment/run.mjs`。`root/` の外に `outside/secret.txt` を置き、`root/` に
そのファイルへの symlink と、`outside` ディレクトリへの symlink を張る。解決関数は次を行う。

1. `relativePath` の正規化（絶対パス・ドライブ表記・NUL・`..` を拒否）
2. `root` を `canonicalPath` で実体化
3. 対象パスを結合し、**存在しない末尾は最も深い既存祖先を canonical 化してから再結合**
4. canonical パスが `root` の配下（前方一致 + セパレータ）であることを確認

## 結果

| ケース | 期待 | 結果 |
| --- | --- | --- |
| 通常ファイル | 読める | PASS |
| `../outside/secret.txt` | 拒否 | PASS |
| `a/b/../../outside/secret.txt` | 拒否 | PASS |
| 絶対パス | 拒否 | PASS |
| 外を指す symlink ファイル | 拒否 | PASS |
| 外を指す symlink ディレクトリ | 拒否 | PASS |
| `./inside.txt` | 読める | PASS |

**7/7**。

## 分かったこと

- `canonicalPath` が最終コンポーネントの symlink も解決するため、**読み取り経路の symlink 脱出は防げる**。
- 新規作成（存在しないパス）は、もっとも深い既存祖先を canonical 化してから末尾を足せばよい。
  ただし**作成時点での親ディレクトリの差し替え**（TOCTOU）は残る。
- 拒否は「例外」ではなく `denied` の結果として返す必要がある（監査ログに残すため）。

## 残っていること（T-02 の未実施部分）

- 監査ログ（誰が・どの `operationId` で・何を拒否したか）
- Root 自体の差し替え（マウント変更・rename）中の挙動
- 書き込み時の `openat2(RESOLVE_BENEATH)` 相当（TOCTOU を閉じる）
- Worker 越し（`RemoteExecutionEnv`）での同じ検証

## 参照

- `poc/root-containment/run.mjs`
- `packages/durable/src/env/index.ts` v1.5.0: `canonicalPath` (:270), `joinPath` (:220)

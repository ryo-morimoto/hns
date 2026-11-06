# Workspace Execution Contract v0.1

2026-11-06 / 草案（実装前） / 前提: [D001](decisions.md)

Editor と Agent が同じファイルに触るとき、黙って壊さない。exactly-once は目的ではない。

## 保証

| 層 | 保証 | 手段 | 破れる条件 |
| --- | --- | --- | --- |
| 観測 | 内容と版が対応 | 読取時に sha256 | 読取中の外部変更 |
| 検出 | 古い版からの置換を拒否 | 置換直前の再ハッシュ | 比較と置換の間（窓） |
| 原子性 | 途中状態を見せない | 同一ディレクトリの temp + rename | 別ファイルシステムへの移動 |
| 冪等 | 再送で二重適用しない | Journal の intent / outcome | Journal の喪失 |
| 調停 | 不明を UNKNOWN として照合 | 内容ハッシュと intent の比較 | — |

「検出」であって「防止」ではない。窓はゼロにできないため、冪等と調停を重ねる。

## API

```ts
type Version = string; // "sha256:<hex>"
interface FileRef { workspaceId: string; rootId: string; relativePath: string }

interface WorkspaceFileApi {
  readFile(ref: FileRef): Promise<{ content: Uint8Array; version: Version }>;
  writeFile(input: {
    ref: FileRef;
    content: Uint8Array;
    expectedVersion: Version | "absent"; // 必須
    operationId: string;
  }): Promise<MutationResult>;
  watch(workspaceId: string, cursor?: string): AsyncIterable<FileEvent>;
}

type MutationResult =
  | { status: "applied"; operationId: string; version: Version }
  | { status: "conflict"; operationId: string; currentVersion: Version | "absent" }
  | { status: "unknown"; operationId: string; reason: "io" | "crash" | "timeout" };
```

全体置換のみ。パッチは v0.2。

## 書き込み手順

1. Root 内であることを検証（下記）
2. 現在の版を計算し、`expectedVersion` と比較。違えば `conflict`
3. Journal に intent を記録（`operationId`, ref, expected, contentHash, temp）
4. 同一ディレクトリに temp を書き、flush
5. 再ハッシュして確認し、`renameFile` で置換
6. Journal に outcome を記録し、イベントを追記

再送は `operationId` で outcome を返す。outcome が無ければ次で照合する。

| 観測 | 判定 |
| --- | --- |
| 版 == contentHash | applied（outcome を補記） |
| 版 == expected | 未適用。同じ `operationId` で再実行可 |
| 一致しない・消えた | conflict または unknown |

`unknown` を applied / conflict に丸めない。

## 認可（Worker）

- `relativePath` を正規化。絶対パス・`..`・NUL・ドライブ表記を拒否
- canonical root と `canonicalPath` の結果を比較し、配下でなければ `denied`
- 新規は「最も深い既存祖先を canonical 化して末尾を結合」
- `.git/` は読み取りのみ
- TOCTOU は残る（`openat2(RESOLVE_BENEATH)` 相当は未対応）

## イベント

`seq` カーソル。`overflow` は全再読込。内容の正本は `readFile`。

## 保証しない

bash・外部エディタ・別プロセス / exactly-once / Root をまたぐ移動 / 時計順序 / 8 MiB 超。

## 未決

パッチ形式 / 巨大ファイル / create-if-absent / Journal 保存先 / lease / イベント保持。
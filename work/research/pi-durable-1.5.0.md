# Pi Durable 1.5.0 実測

2026-11-06。対象: `pi-durable` / `pi-env` / `pi-ai` **1.5.0**（tag `f9a2636`）。
行番号は v1.5.0。調査時の main は 1211ファイル差分があり、exact pin が必要。

## 事実

| 項目 | 内容 | 出所 |
| --- | --- | --- |
| 境界 | `ExecutionEnv` = FileSystem + Shell | `env/index.ts:377` |
| 書き込み | `writeFile` に版・条件が無い。実装は `fs.writeFile`（インプレース） | `:239`, `node.ts:1014` |
| 原子的置換 | `renameFile` はある（writeFile は使わない） | `:245` |
| 直列化 | 同一プロセス内のみ。「Not a lock against `bash`」 | `file-mutation-queue.ts:31` |
| 監視 | `paths` / `overflow` / `failed` を流すだけ。カーソル・履歴なし | `:127`, `:265` |
| listFiles | optional。ローカルNode環境は未実装、daemon のみ | `:254` |
| replay | `replay: "safe"` でないツールは中断。副作用の冪等性は自前 | README "Tools" |
| 遠隔 | `RemoteExecutionEnv`（SSH + Rust daemon、host key確認、listFiles） | `env/README.md` |

## 結果

| 検証 | 結果 | コード |
| --- | --- | --- |
| T-01 適合（LocalExecutionEnv） | **29/29** | `work/work/poc/env-conformance` |
| T-01 適合（NodeExecutionEnv） | 24/29（listFiles 5件未実装） | 同上 |
| 失更新 | 2クライアント同時書き込みで後勝ち、エラーなし | `work/work/poc/mutation-gap` |
| T-02 部分（traversal・symlink） | **7/7 拒否** | `work/work/poc/root-containment` |

## 含意

1. 条件付き書き込みは Workspace 層が持つ（ADR-0001）。組み込み `write`/`edit` は本番で使わない。
2. 置換は「同一ディレクトリの一時ファイル → rename」。`createTempFile` は tmp 配下なので使えない。
3. 版は `sha256(content)`。Progress は watch ではなく自前 Journal から復元する。

## 未確認

SQLite のクラッシュ耐性・複数プロセス / SSH越しの daemon / Windows・macOS。
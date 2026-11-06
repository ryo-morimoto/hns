# Pi Durable 1.5.0 — ExecutionEnv と永続化の実測

- 更新日: 2026-11-06
- 種別: 調査記録（この時点のスナップショット。追記は新しい番号で行い、本文は書き換えない）
- 対象: `@earendil-works/pi-durable` / `pi-env` / `pi-ai` 1.5.0
- 関連: U-02（Pi Durable API）、T-01、INV-02〜INV-07、[Workspace Execution Contract v0.1](../design/workspace-execution-contract-v0.1.md)

## 1. 何を確かめたかったか

要件v0.3では「ExecutionEnv が境界になる」「条件付き書き込みを Workspace が担う」を**設計仮説**としていた。
ここでは、その仮説が実APIで成立するかを実物で確認した。

1. `ExecutionEnv` の実際のメソッドと、書き込み・監視の保証範囲
2. 条件付き書き込み（expectedVersion）や冪等な Mutation が既存APIにあるか
3. T-01（適合テスト）を実行できるか、結果は何か
4. 遠隔マシン実行（要件#2）の既存部品があるか

## 2. 固定したもの

| 対象 | 版 | 根拠 |
| --- | --- | --- |
| `@earendil-works/pi-durable` | **1.5.0**（exact） | npm `dist-tags.latest`、git tag `v1.5.0` |
| `@earendil-works/pi-env` | **1.5.0**（exact） | 同上 |
| `@earendil-works/pi-ai` | **1.5.0**（exact） | 同上 |
| git tag | `f9a26365568127461c47a07a37dcb42c140a3ac5` | `git ls-remote --tags` |

- 本稿の `file:line` は **タグ v1.5.0** のツリーで確認した。
- 調査時点の `main` は `4ffe32c`（2026-11-06 09:59 UTC）で、v1.5.0 から **1211ファイル・約6万行**の差分があった。
  Durable の README も「API changes without notice between releases」と明記している。
  **版の固定は調査上の前提であり、依存としては exact pin が必須**（ADR-0001）。

## 3. 確認した事実

### 3.1 ExecutionEnv は FileSystem + Shell

`packages/durable/src/env/index.ts:377`:

```ts
export interface ExecutionEnv extends FileSystem, Shell {}
```

FileSystem（`:212`）の主要メソッド:

| メソッド | 行 | 保証・注意 |
| --- | --- | --- |
| `id` | 217 | 同じ id は同じファイル名前空間。ローカルNode環境は `node:local` を共有 |
| `readTextFile` / `readBinaryFile` | 221 / 228 | 失敗は例外でなく `Result` |
| `openBinaryReader` | 234 | 開いた実体を読む。`noFollow` で最終リンクを拒否 |
| `writeFile` | 239 | **版・条件・期待値の引数が無い** |
| `appendFile` / `truncateFile` | 240 / 242 | 同上 |
| `flushFile` | 244 | 開いているハンドルの flush。パス指定の耐久化ではない |
| `renameFile` | 245 | 原子的置換の材料 |
| `listFiles` | 254 | **optional**。未実装なら `not_supported` |
| `watch` | 265 | 変更通知。履歴・カーソルは無い |
| `canonicalPath` | 270 | 実パス解決 |
| `createTempDir` / `createTempFile` | 282 / 283 | 作るのは環境の tmp 配下 |

Shell（`:362`）は `exec(string | readonly string[])`（シェル経由 / argv 直接）と `cleanup` のみ。

### 3.2 書き込みは無条件・インプレース

`NodeExecutionEnv.writeFile`（`packages/durable/src/env/node.ts:1014-1027`）は、親ディレクトリの `mkdir` の後、
`fs.writeFile` をそのまま呼ぶ。**一時ファイル + rename ではない**ため、書き込み途中でプロセスが死ぬと
切り詰められた内容が残り得る。`renameFile` は存在するが `writeFile` は使っていない。

### 3.3 直列化はプロセス内だけ

`packages/durable/src/tools/file-mutation-queue.ts:31` のコメント:

> Serialize `edit` and `write` mutations of one file within this process: same file system id and canonical path,
> whichever environment object the call got. ... **Not a lock against `bash` or other processes.**

つまり Durable の `write`/`edit` ツールは、同一プロセス内の同時実行だけを直列化する。
外部エディタ・`bash`・別プロセスの変更とは競合を検出しない。

### 3.4 適合テストは公開されている

`@earendil-works/pi-durable/testing` が `createEnvConformance(options): EnvConformanceCase[]` を公開している
（v1.5.0 `src/testing/index.ts:3`）。VIテストランナーに依存せず、任意の assert 実装で回せる。
`listFiles` は `options.listFiles: true` を渡したときだけ検査される（`testing/types.ts:37-38`）。

### 3.5 ツールは永続タスクで、replay 方針を選ぶ

README「Tools」の記述:

- 各ツール呼び出しはそれ自体が durable task。意図（intent）が `execute()` の前にコミットされる。
- プロセスが途中で死んだ場合、`replay: "safe"` のときだけ再実行される。それ以外は `interrupted` のエラー結果になる。
- ネスト呼び出しは key で再実行を吸収するが、「replay-safe な外部副作用ツールは自前の冪等性が必要」と明記。

→ Workspace の書き込みツールは、**安易に `replay: "safe"` にしない**。再実行するなら `operationId` で冪等にする。

### 3.6 watch はイベントを流すが履歴は無い

`FileChange`（`:127`）は `paths` / `overflow` / `failed` の3種。`FileWatcher.mode` は `native`（約2秒以内）か
`polling`。切断・イベント喪失時は `overflow` が来て、監視対象全体の再スキャンが必要になる。

カーソル・再送・履歴は無い。**UIのProgress投影を再接続後に再構成するには、自前の永続イベントログが要る**（INV-06）。

### 3.7 遠隔実行は pi-env が既に提供している

`@earendil-works/pi-env` は、SSH 越しの Rust デーモン（`pi-env`）とフレームプロトコルで通信する
`RemoteExecutionEnv` を提供する。ホスト鍵の確認、デーモンの SHA-256 検証付き配置、`listFiles`、
`openTerminal`、`openProcess` を含む。`packages/env/docs/semantics.md` は `NodeExecutionEnv` を参照実装とし、
`mkdir`/`rm`/`mkdtemp` などの差分を明記している。

→ 要件#2「複数マシンでCore Agentを動かせる」の実現候補として、**中央Harness + `RemoteExecutionEnv`** が具体化できる。
ただしこれは「中央Harness + 遠隔Tool」であり、要件#2の文言を満たすかの解釈（U-01）は依然として決める必要がある。

### 3.8 ストレージ

Memory / JSONL / SQLite（Node、Cloudflare Durable Object）/ IndexedDB。`Harness.open(storage, ...)`、
`harness.resume()`、`readOnly: true` のオープン。`requestId` による Submission の再送照合がある。
Workspace の Journal をこの Storage に相乗りさせるか別DBにするかは未決（U-15）。

## 4. 実測結果

環境: Linux、Node v24.15.0、2026-11-06。コード: [`poc/env-conformance/run.mjs`](../../poc/env-conformance/run.mjs)

| 実行 | 対象 | 結果 | 備考 |
| --- | --- | --- | --- |
| `node run.mjs node` | `NodeExecutionEnv` | **24/29 合格** | `listFiles` の5件が「未実装」で失敗 |
| `node run.mjs local` | `LocalExecutionEnv`（pi-env daemon） | **29/29 合格** | `listFiles` を含む全契約 |

- ローカルNode環境は `listFiles` を持たない（daemon 経由の環境だけが持つ）。
- それ以外の FileSystem / Shell 契約は、ローカルでも v1.5.0 で満たされる。

### 4.1 失われる更新とシェル迂回の確認

`poc/mutation-gap/run.mjs` の結果:

```
lost update — final content: "line-1\nB\n"      # A の編集はエラーなく消えた
shell bypass — env read still equals pre-shell snapshot: false
shell bypass — actual content: "shell-change\n"  # API外の変更をAPIは知らない
```

2つのクライアントが同じ版を読み、両方が全体を書き戻すと、後勝ちで片方が消える。エラーは出ない。
`bash` の書き込みは API を経由しないため、API 側の版確認だけでは捕捉できない。

## 5. 設計への含意

1. **条件付き書き込みは ExecutionEnv に無い。** Workspace 層が `expectedVersion` と `operationId` を持つ（ADR-0001）。
2. **原子的置換は `renameFile` で実装できる。** ただし一時ファイルは**対象と同じディレクトリ**に作る必要がある
   （`createTempFile` は tmp 配下なので使えない）。
3. **版は内容ハッシュ（sha256）を基本にする。** mtime は粒度・クロックスキューで弱く、同じ内容を別版と誤認する。
4. **「確認してから置換」の間にも競合窓が残る。** これは保証ではなく検出 + `UNKNOWN` として設計する（INV-04）。
5. **Progress 投影は自前のイベントログ。** `watch` にカーソルも履歴も無い（INV-06）。
6. **replay 安全でないツール + `operationId`。** 二段構えで再送に耐える。

## 6. 未確認・残るリスク

- npm 1.5.0 と main（`4ffe32c`）の差分が大きい。本稿は v1.5.0 の tree と npm 1.5.0 の実行に基づく。
- SQLite ストレージのクラッシュ耐性、複数プロセス同時オープンの挙動は未試験。
- SSH 越しのデーモン配布を本環境では試していない（`LocalExecutionEnv` のみ）。
- `replay: "safe"` の実際の再実行条件は README の記述に基づく。テストコードは未読。
- Windows / macOS の差は未確認（本環境は Linux のみ）。

## 7. 参照

- `packages/durable/src/env/index.ts`（v1.5.0）: 127, 212, 217, 239, 245, 254, 265, 362, 377
- `packages/durable/src/env/node.ts`: 1014-1027
- `packages/durable/src/tools/file-mutation-queue.ts`: 31
- `packages/durable/src/testing/index.ts`: 3-4
- `packages/durable/README.md`: Persist and Resume / Tools / Watching a Conversation
- `packages/env/README.md`, `packages/env/docs/semantics.md`
- 実行コード: `poc/env-conformance/`, `poc/mutation-gap/`

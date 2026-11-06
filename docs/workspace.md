# Workspace Execution Contract v0.1

2026-11-06 / **v0.1 実装済み（PoC）** / 前提: [D001](decisions.md)

Editor と Agent が同じファイルに触るとき、黙って壊さない。exactly-once は目的ではない。

## 保証

| 層 | 保証 | 手段 | 破れる条件 |
| --- | --- | --- | --- |
| 観測 | 内容と版が対応 | 読取時に sha256 | 読取中の外部変更 |
| 検出 | 古い版からの置換を拒否 | ヘルパー内で再ハッシュしてから rename | ヘルパーを実行できない環境 |
| 封じ込め | 差し替えられた親を辿らない | root の dirfd から `O_NOFOLLOW` で開き、rename も dirfd 相対 | ヘルパーを実行できない環境 |
| 原子性 | 途中状態を見せない | 同一ディレクトリの temp + rename | 別ファイルシステムへの移動 |
| 冪等 | 再送で二重適用しない | Journal の intent / outcome | Journal の喪失 |
| 調停 | 不明を UNKNOWN として照合 | 内容ハッシュと intent の比較 | — |

「検出」であって「防止」ではないが、検査と使用は同一の解決にする（下記「TOCTOU」）。
そこができない環境では窓が残るので、冪等と調停を重ねる。

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
4. root 直下に temp を書き、flush（名前は内部生成の UUID。`operationId` はトークンで、パスには使わない）
5. ヘルパー内で再ハッシュして確認し、dirfd 相対で rename して置換（下記「TOCTOU」）
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
- 操作ごとに root の存在を確認。消えていたら `denied`（書き込みで再作成しない）
- 拒否は `operationId` 付きで Journal の `audit` に残す
- **root の同一性**: Journal の `id` と root 内の `.hns/root.json` を照合する。欠落・不一致なら開かない（fail closed）
- **exec の隔離**: 起動時に bubblewrap を検出し、通らなければ exec を出さない（fail closed）。通ったときは `createSandboxEnv` で root だけ書き込み可能・他は読み取り専用。ネットワークは残す
- **TOCTOU**: 解決と使用を同じ dirfd で行う（下記）。ヘルパーを実行できない環境では、rename 直前に親の canonical を再確認し、変わっていれば `unknown` に落とす（窓は残る）
- **exec の環境**: sandbox は `--clearenv` でサーバの env を落とし、`PATH` と `HOME`（root）などだけを戻す。`SandboxOptions.hide` のディレクトリは tmpfs で隠す（鍵のディレクトリは呼び出し側が渡す）
- root が symlink のときは、開いた時点の解決結果に固定する。差し替えは反映されない
- Windows の区切り・大文字小文字、macOS の正規化は未検証（Linux のみ）

### 脅威モデル

- `exec` は sandbox で root 外に書けない（bubblewrap が要る）。
- 同一ユーザーの別プロセスが root 内で親ディレクトリを差し替えても、dirfd で解決する限り root の外は触れない。
- Root の外を作り変えられた場合（マウント差し替え等）は OS の権限の範囲。

### TOCTOU（0005）

パスの解決と open / rename を 1 回の解決にまとめる。ExecutionEnv のファイル API はパスしか取らないため、解決は別プロセスに任せる。

- 書込: temp を root 直下に書いたあと、`rooted.mjs` が root の dirfd を開き、各親を `O_NOFOLLOW | O_DIRECTORY` で辿り、対象を再ハッシュして `expectedVersion` と比べ、**その親の dirfd から** rename する。親の差し替えはこれで閉じるが、**同名ファイルを hash と rename の間に差し替える窓は残る**（Linux に compare-and-rename は無い）。
- 読取: 同じ辿りで最終コンポーネントを `O_NOFOLLOW` で開き、開いた fd から読む。内容は base64 で 1 本の stdout に返す。
- root の同一性は `.hns/root.json` を dirfd 経由で読み、`probe` で記録した dev / ino と照合する。パスを差し替えられても別のディレクトリは開かない。
- 起動時に `probe` を 1 回実行して可否を決める。失敗したら（Linux 以外・exec 無し・ヘルパーが届かないホスト）従来の再確認にフォールバックし、`Workspace.mode` が `checks` になる。
- コスト: 操作ごとに Node を 1 プロセス起動する（数百 ms）。常駐化は未対応。

## exec を出せる条件（0006）

起動時に `detectSandbox()` が次を順に確かめ、どれかで落ちれば `exec: "disabled"` を返す。アプリは bash ツールを登録せず、ワークフローの tool ノードも `createNoExecEnv` が拒否する。生の exec に落とさない。

| 確認 | 落ちたときの `code` | `userNamespaces` |
| --- | --- | --- |
| Linux か | `unsupported-platform` | `unknown` |
| `BWRAP` か PATH に実行可能な bwrap がある | `not-found` / `not-executable` | `unknown` |
| `bwrap --version` が読める | `version-failed` | `unknown` |
| wrapper と同じ引数で 1 回動く（user namespace・mount・shell） | `userns-unavailable` / `shell-missing` / `smoke-test-failed` | `blocked` / `unknown` |

`/api/health` の `sandbox` は `{ available, exec, backend, bwrap, version, shell, userNamespaces, sysctls, code, reason, checkedAt }` を返す。バージョンは報告するが下限は設けない（0.12.0 で検証。実効性は毎回の probe で見る）。

shell は `/bin/sh` → `/usr/bin/sh` → `$SHELL` の順で存在するものを使う。NixOS のように `/bin/true` が無い環境で検出を誤らないため、probe も wrapper も同じ shell を使う。

macOS / Windows は exec を出さない。候補（sandbox-exec / AppContainer）と実測は [sandbox-platforms.md](../work/research/sandbox-platforms.md)。

## イベント

Journal が §seq§ を発番し、§watch(cursor)§ が履歴を再生してから購読する。内容の正本は §readFile§。

- 自分の書き込みは §applied§ の後に §created§ / §changed§ を発行する。
- 外部変更は §ExecutionEnv.watch§ で拾い、パスごとに 100ms まとめてから再ハッシュして発行する。
- 同じ版なら発行しない（自分の書き込みと watcher の二重を防ぐ）。
- §overflow§ は「全体を読み直せ」の合図。クライアントはパス単位の信頼を捨てる。

## 保証しない

bash・外部エディタ・別プロセス / exactly-once / Root をまたぐ移動 / 時計順序 / 8 MiB 超。

## 検証

`work/poc/workspace-core` が §expectedVersion§ の比較、temp + rename、Journal の intent/outcome、
recover（applied / pending / unknown）を実装。**40/40 合格**（Node env と pi-env daemon の両方）。

`work/poc/workspace-core/toctou.mjs` が親ディレクトリの差し替えを再現し、dirfd 経路では root の外に出ないこと、
`checks` 経路では出てしまうこと（窓の証拠）、exec が無いときのフォールバックを検証。**32/32 合格**（両 env）。
`work/poc/sandbox` が bwrap の検出（欠落・非実行・偽物・user namespace）と封じ込めを検証。**18/18 合格**（bwrap 0.12.0 / NixOS）。
`work/poc/app/run-safety.mjs` は検出の状態と、sandbox が無いときに tool ノードが動かないことを検証（**15/15**）。bwrap が無い環境では封じ込めだけを SKIP する。

| 試験 | 内容 |
| --- | --- |
| T-03 | 同じ版から2クライアント → 片方 applied、片方 conflict。上書きなし |
| T-04 | intent 後 / temp 後 / rename 後の停止 → pending / pending / applied。再送で二重適用なし |
| - | rename 後に第三者が変更 → unknown（applied にも conflict にも丸めない） |
| - | 同じ §operationId§ の再送は記録済みの結果を返し、後からの外部変更を上書きしない |
| T-05 | 親を差し替えながら書き込みを繰り返す → dirfd では root の外に 0 件、`checks` では 1 件出る（対照） |
| - | 親を差し替えた直後の読取 → dirfd は辿らない。最終コンポーネントの symlink は両経路で拒否 |
| - | exec が無い環境 → `checks` に落ちて従来どおり読み書きできる |

## 限界（実装で確認したもの）

- Journal の保存は §writeFile§（非原子）。原子的な追記ログにする必要がある。
- temp は root 直下の §.hns-tmp-<uuid>§（内部生成）。Agent から見える。制御用ディレクトリに逃がす。
- 親の差し替えは dirfd で閉じた。**同名ファイルの差し替え**は hash と rename の間に残る。ヘルパーが動かない環境では親の窓も残る（`Workspace.mode === "checks"`）。
- `SandboxOptions.hide` は既定で空。サーバの composition root が鍵のディレクトリを渡す。
- ヘルパーは操作ごとに Node を起動する（1 操作あたり数百 ms）。リモートの daemon に配る手段は未定。
- dirfd 経路の読み取りは 8 MiB まで。超えると `invalid` で断る。
- ディレクトリの fsync をしないため、rename の耐久性は保証しない。
- create-if-absent の競合、巨大ファイル、パッチは未対応。
- bwrap は 0.12.0 でしか検証していない。macOS / Windows の backend は無い（[0006](../work/issues/0006-sandbox-deploy.md)）。

## 未決

パッチ形式 / 巨大ファイル / create-if-absent / Journal 保存先 / lease / イベント保持 / ヘルパーの配布。
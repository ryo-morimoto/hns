# Workspace Execution Contract v0.1（草案）

- 更新日: 2026-11-06
- 状態: **草案（実装前）**。要件v0.3 §5.1 の提案契約を、Pi Durable 1.5.0 の実APIに合わせて具体化したもの。
- 前提: [ADR-0001](../decisions/0001-pin-pi-durable-1.5.0.md)（ExecutionEnv を境界にし、条件付き書き込みは Workspace 層が持つ）
- 根拠: [Pi Durable 1.5.0 の実測](../research/01-pi-durable-1.5.0-executionenv.md)
- 受入試験: T-02（認可）、T-03（競合）、T-04（クラッシュ）

## 1. 目的と非目的

**目的**（Editor と Agent が同じファイルに触るとき、黙って壊さない）:

1. 古い版からの書き込みを**検出して拒否**する（INV-03）
2. 再送で**二重適用しない**（INV-04）
3. 結果が分からないときに、成功/失敗の二値へ**潰さない**（INV-04）
4. 外部変更（bash・別プロセス）を**検出して通知**する（INV-07）
5. 認可された Root の外へ**出さない**（INV-02）

**非目的**:

- Exactly-once の保証
- すべてのファイル変更の捕捉（`bash` は API を通らない）
- 分散トランザクション（Agent Checkpoint とファイル変更は別、INV-05）

## 2. 保証の階層

| 層 | 保証 | 手段 | 破れる条件 |
| --- | --- | --- | --- |
| L0 観測 | 読んだ内容と版が対応する | 読取時に sha256 を計算 | 読取中に外部が書き換える |
| L1 検出 | 古い版からの置換を拒否する | 置換直前に現在版を再計算して比較 | 比較と置換の間に外部が書く（窓） |
| L2 原子性 | 途中状態を見せない | 同一ディレクトリの一時ファイル + flush + `renameFile` | 別ファイルシステムへの移動 |
| L3 冪等 | 同じ `operationId` の再送で二重適用しない | Journal の intent / outcome | Journal の書き込み自体が失われる |
| L4 調停 | 結果不明を `UNKNOWN` として照合できる | 置換後の内容ハッシュと intent の照合 | 内容が偶然一致する（ハッシュ衝突は無視できる） |

**L1 は「検出」であって「防止」ではない。** 比較と rename の間の競合窓はゼロにできない。
だからこそ L3/L4 を重ね、最終的な正しさは「静かに壊れないこと」に置く。

## 3. 用語

- **Workspace**: Root・実行先・ポリシーを束ねる境界。
- **Root**: Machine 上の許可済みディレクトリ。
- **FileRef**: `{ workspaceId, rootId, relativePath }`。パスは Root 相対。
- **Version**: `sha256:<hex>`。内容のハッシュ。mtime は使わない。
- **Operation**: 1回の Mutation 要求。`operationId` はクライアントが生成し、再送で同じ値を使う。
- **Journal**: intent / outcome の永続記録。Workspace が所有する。

## 4. API（v0.1）

```ts
type Version = `sha256:${string}`;

interface FileRef {
  workspaceId: string;
  rootId: string;
  relativePath: string;
}

interface ReadResult {
  ref: FileRef;
  content: Uint8Array;
  version: Version;
  size: number;
}

type MutationResult =
  | { status: "applied"; operationId: string; version: Version }
  | { status: "conflict"; operationId: string; currentVersion: Version | "absent" }
  | { status: "unknown"; operationId: string; reason: "io" | "crash" | "timeout" };

interface WorkspaceFileApi {
  readFile(ref: FileRef, options?: { maxBytes?: number }): Promise<ReadResult>;

  writeFile(input: {
    ref: FileRef;
    content: Uint8Array;
    /** 置換してよい版。"absent" は新規作成のみ許可。 */
    expectedVersion: Version | "absent";
    /** クライアント生成。再送で同じ値。 */
    operationId: string;
  }): Promise<MutationResult>;

  watch(workspaceId: string, cursor?: string): AsyncIterable<FileEvent>;
}

type FileEvent =
  | { seq: string; kind: "changed"; ref: FileRef; version: Version }
  | { seq: string; kind: "created"; ref: FileRef; version: Version }
  | { seq: string; kind: "deleted"; ref: FileRef }
  | { seq: string; kind: "renamed"; from: FileRef; to: FileRef }
  | { seq: string; kind: "overflow" };
```

**v0.1 で決めたこと**

- 書き込みは**全体置換のみ**。部分パッチ（`applyPatch`）は v0.2 に送る。
- `expectedVersion` は必須。省略を許すと「黙って上書き」が既定になる。
- 内容は `Uint8Array`。テキスト判定は呼び出し側の責務。
- `watch` のカーソルは **Journal の `seq`**。`ExecutionEnv.watch` のイベントは入力であって正本ではない。

## 5. 書き込み手順

```text
1. Worker が ref を解決し、Root 内であることを検証（§6）
2. 現在の内容を読み、version を計算
3. expectedVersion と一致しなければ → conflict（書き込みしない）
4. Journal に intent を記録
   { operationId, ref, expectedVersion, contentHash, tempName, at }
5. 対象と同じディレクトリに一時ファイルを作り、内容を書き、flush
6. 再度 version を計算（窓を狭める）。変わっていれば一時ファイルを捨てて conflict
7. renameFile(temp → target)
8. Journal に outcome を記録 { operationId, applied, version }
9. FileEvent を Journal に追記
```

**再送（同じ `operationId`）**

- outcome があれば、その結果をそのまま返す（`applied` / `conflict`）。
- outcome が無く intent だけがある → §5.1 で照合する。

### 5.1 クラッシュ後の照合

| 観測 | 判定 | 返す |
| --- | --- | --- |
| target の版 == intent.contentHash | 適用済み | `applied`（outcome を補記） |
| target の版 == intent.expectedVersion | 未適用 | 再実行してよい（同じ `operationId`） |
| target が存在しない（expected が "absent" でない） | 外部削除 | `conflict` |
| どれにも一致しない | 判定不能 | `unknown`（呼び出し側が読んで解決） |
| Journal 自体に intent が無い | 未開始 | 実行してよい |

`unknown` を `applied` にも `conflict` にも丸めない。UI は「不明」を表示し、再読込で解決する。

### 5.2 `expectedVersion: "absent"` の限界

新規作成は「存在しないこと」を期待する。`renameFile` は既存ファイルを上書きするため、
**作成と他者の作成が競合した場合の最後の窓は閉じない**。v0.1 では「作成の競合は検出して conflict を返す」
までを目標にし、原子的な create-if-absent は OS 機能（`open(O_CREAT|O_EXCL)` 相当）の追加を待つ（§11）。

## 6. 認可とパス解決（Worker 側）

1. `relativePath` を正規化する。拒否: 絶対パス、`..` セグメント、NUL、Windows のドライブ表記。
2. `root` と結合し、`canonicalPath` で実パスを得る。
3. 実パスが canonical root の配下であることを確認する（symlink 脱出を拒否）。
4. 最終認可は **Worker が操作時点で**行う（Control Plane の事前検査だけに依存しない）。
5. v0.1 では `.git/` への書き込みを拒否する。読み取りは許可。

**限界**: `canonicalPath` による解決と実際の open の間には TOCTOU がある。
v0.1 は「検出して監査ログに残す」までとし、`openat2(RESOLVE_BENEATH)` 相当の保証は別途（§11）。

## 7. イベントとカーソル

- Journal が `seq` を単調増加で発番する。クライアントは最後に受けた `seq` をカーソルとして保持する。
- `overflow` を受けたら、クライアントは**監視対象全体を再読込**する（パス単位の信頼を捨てる）。
- イベントは「変更があった」ことの通知であり、内容の正本ではない。内容は `readFile` で取り直す。
- `ExecutionEnv.watch` の `paths` はヒントとして使い、確定は `readFile` の version で行う。

## 8. エラー分類

| code | 意味 | 再試行 | 呼び出し側の行動 |
| --- | --- | --- | --- |
| `not_found` | Root またはファイルが無い | しない | 表示・再同期 |
| `conflict` | 期待版と現在版が違う | 再読込後 | 差分を見せ、ユーザーに選ばせる |
| `denied` | Root 外・禁止パス・権限なし | しない | 監査ログ、UI に理由 |
| `unknown` | 適用是否が不明 | 照合後 | 再読込して解決。自動再適用しない |
| `unavailable` | Worker 切断・タイムアウト | する | バックオフ。結果は `unknown` として扱う |
| `invalid` | パス・版の形式不正 | しない | 実装のバグとして扱う |

## 9. 保証しないこと

- `bash`・外部エディタ・別プロセスの書き込み
- クラッシュ時の Exactly-once（照合できるだけ）
- Root をまたぐ移動の原子性
- ネットワーク分断中の到達保証
- 時計による順序（`seq` は Journal が発番する）
- 巨大ファイル（既定上限 8 MiB。超えるものは v0.1 では読み取り専用）

## 10. 受入試験との対応

| 試験 | この契約で確かめること | 合格の形 |
| --- | --- | --- |
| T-02 | Root 外・`..`・symlink 脱出・絶対パスの拒否 | すべて `denied`、正常 read は成功、監査に残る |
| T-03 | 同じ版から Editor と Agent が書く | 片方 `applied`、片方 `conflict`。dirty Buffer は保持 |
| T-04 | intent 後・rename 前・outcome 前に停止 | §5.1 の表どおりに判定。二重適用なし |
| T-07 | 切断後にカーソルから再購読 | 最終状態と一致、`overflow` で全再読込 |

## 11. 未決（v0.2 以降）

| ID | 論点 | 現時点の案 |
| --- | --- | --- |
| W-01 | 部分パッチ API の形 | unified diff ではなく、置換リスト + 期待版 |
| W-02 | バイナリ・巨大ファイル | 上限超えはメタデータのみ、書き込みは別プロトコル |
| W-03 | create-if-absent の原子性 | `O_CREAT\|O_EXCL` 相当を ExecutionEnv に足せるか、daemon 側で実装 |
| W-04 | Journal の保存先 | Workspace ごとの SQLite / Durable の Storage と分離 |
| W-05 | ロック（lease）を持つか | 楽観のみで開始。競合が多い操作だけ lease |
| W-06 | イベントの保持・圧縮 | `seq` 単位で切り詰め、購読者は必要なら再読込 |
| W-07 | ディレクトリ・rename の版 | v0.1 対象外 |
| W-08 | Editor Buffer の保存単位 | クライアント側の dirty 管理、保存は本 API 経由 |

## 12. 変更履歴

- v0.1（2026-11-06）: 初版。要件v0.3 §5.1 のプレースホルダーを、Pi Durable 1.5.0 の実測に合わせて確定。

# 契約: Workspace のファイル（版・absent・checkpoint）

2026-11-18 / L6 M2。**この面の契約の正本**。実装は `@hns/workspace`（`files.ts` / `checkpoint.ts` / `types.ts`）と `server/src/do/workspace.ts`、機械側は `@hns/machine`。不変条件は [invariants.md](../invariants.md) の INV-03 / INV-04 / INV-05。

## 版（version）と absent

- **version** は内容の sha256（`"sha256:<hex>"`）。ファイル名ではなくバイト列を指す。
- **absent** は「その名前が無い」を表す。core の `AbsentVersion = string | "absent"` と `ABSENT_VERSION` を使う（`workspace/src/types.ts` の `ExpectedVersion` は削除済み）。**型は文字列なので、"absent" 以外の値も通る**（リテラル拘束ではない）。値は必ず `versionAt()` の結果（`sha256:…` か `absent`）にする。
- 書き込みは **expectedVersion 必須**。無条件の上書きは無い。absent は「まだ無い」ことを要求し、読んだ後に作られたファイルを上書きしない。

## 書き込み（apply）

1. Worker → Workspace DO が intent を書く（journal）。`operationId` は 1 試行に 1 つ。
2. DO は版表で第 1 段の比較をし、**機械**に渡す。機械は ROOT を dirfd で開き、`projectRoot` と `path` を別々に解決して**再ハッシュ**し、expectedVersion と比べる（INV-03）。
3. 一致すれば同一親の temp に書き、fsync して rename、再ハッシュ。result は `applied`（新しい version）/ `conflict`（`currentVersion`）/ `denied`（書いていない確定的な拒否）/ `unknown`（応答が無い）。
4. DO は outcome・版・event を **1 トランザクション**で書いてから 200 を返す（INV-10）。応答が無ければ outcome は `unknown`（504）。

- 同じ `operationId` で内容（`contentHash` / `expectedVersion`）が違えば `denied`（`operation_id_reused`）。同じ内容なら既存の outcome を返す（INV-04）。
- `unknown` の再送は、機械の現在のハッシュで `applied` に落ちるか照合する。**`unknown` を applied / conflict に丸めない**。
- 面の status は [failures.md](failures.md)（conflict 409 / denied 400 / unknown 504 / unavailable 503）。

## 読み（read）

- 読みは**機械から**返す（R2 や D1 の写しではない）。切断中は 503 `unavailable` で、古い内容を返さない。
- 版表と機械の版が食い違えば `externalChange: true` を返す（agent の shell など、経路の外の変更）。

## checkpoint（Run 境界）

- `checkpointRun({ root, runId, committedAt? })` は一時 index に作業ツリーを足し、parent の無い commit を作り、`refs/hns/checkpoints/<runId>` を CAS で進める。ユーザーの HEAD / index / worktree は触らない。
- 除外は `.gitignore` に加え、tracked の `.hns` / `.env*` / 資格情報名 / `node_modules`（名前ベース。**内容は走査しない**）。
- 同じ `runId` は `created: false` で既存 commit を返す。pack は commit の object closure から作る。
- 結果は commit / ref / `checkpoints/<commit>.pack` と pack の bytes、加えて **`packBytes`**（pack のサイズ）と **`maxBlobBytes`**（pack 中の最大 blob）。どちらも machine の `checkpoint` operation が metadata として Worker に返し（0244）、mirror は `maxBlobBytes` を Artifacts の 32MiB/file と、`packBytes` を 64MiB/push と比べる（D106）。
- 呼ぶのは Run の終了・中断・lease 解放・SIGTERM。crash は対象外（durability §3.3）。
- restore は 0155（未実装）。この契約の入出力（commit / ref / packKey / pack bytes / packBytes / maxBlobBytes、読み戻しは `readCheckpointPack`）を変えるときは、公開面の変更になる。

## 変わったとき

版の語彙・apply の段・checkpoint の形を変えるなら、このファイルと `files.ts` / `checkpoint.ts` の TSDoc を同時に。INV-03 / INV-04 を弱めるには決定の追記が要る。

# 契約: machine（署名・ROOT 封じ込め・操作）

2026-11-18 / L6 M2 の続き。**この面の契約の正本**。実装は `@hns/core` の `machine.ts`（署名の形）と `@hns/machine`（agent / wire / operations / containment / refusal）、サーバ側は `server/src/do/machine.ts`。不変条件は [invariants.md](../invariants.md) の INV-01 / INV-02 / INV-03。

## 経路

- サーバ → machine は **`/rpc`**（`MACHINE_RPC_PATH`）と、checkpoint の pack だけの **`/rpc/checkpoint/<runId>/pack`**。署名がこのパスを含むので、ほかのパスは受け付けない。pack のルートは runId を含むので、ある Run 用に署名した pack を別の Run のパスへ送ると署名が合わない。
- 認証は **Worker 側の control-plane 鍵で署名**し、machine が enrollment で配られた公開鍵で検証する（D100）。device 鍵は machine → Worker の向き（[auth](auth.md)）。

## 署名

- メッセージは JSON 配列 `[version, machineId, connection, seq, timestamp, nonce, method, path, bodyHash]`（`signatureMessage`）。version は `hns.machine.request.v1`。
- ヘッダは `core/machine.ts` の `SIGNED_FIELD_BY_HEADER` が唯一の写像（`x-hns-machine` / `connection` / `seq` / `timestamp` / `nonce` + `x-hns-signature`）。**署名対象のフィールドを増やすときは、写像と `signatureMessage` と検証を同時に。**
- `x-request-id` は**署名対象にしない**（相関 ID で、改ざんを拒否理由にしない）。
- 拒否は閉じた語彙 `MACHINE_REFUSALS`（`core/machine.ts`）。status は [failures.md](failures.md) の machine 面。

## ROOT 封じ込め（INV-02）

- machine は起動時に ROOT の dev/ino を取り、**操作のたびに照合**する（root の差し替えは internal で fail closed）。
- パスは `projectRoot` と `path` を**別々に**受け、ROOT を dirfd で開き、各段を `O_NOFOLLOW | O_DIRECTORY` で辿る。最終要素は `O_NOFOLLOW | O_NONBLOCK` で開く。
- 絶対パス・`..`・中間 symlink・ROOT 外・他ユーザーの path は拒否（`path_denied`）。Node の `fs` は compare-and-rename を持たないため、**同名ファイルの差し替え窓は許容**し、その限界を TSDoc に書く。

## 操作

- **health / stat / read / list** は読み取りのみ。**write** は版付き（`expectedVersion` 必須）で、機械が現在の版を**再計算**して比べる（INV-03）。一致しなければ `conflict`、書いていなければ `denied`。
- write は同一親の temp に書いて fsync し、rename してから再ハッシュする。path 単位で直列化する。
- **checkpoint**（0244）は `{ "op": "checkpoint", "runId", "committedAt"? }` を受け、作業ツリーを parent の無い commit にして `refs/hns/checkpoints/<runId>` を CAS で進め（`@hns/workspace` の `checkpointRun`）、**metadata だけ**を返す: runId / ref / commit / packKey / objectCount / packBytes / maxBlobBytes / created（0243 の `CheckpointPrepareResult`）。pack はこの応答に入らない。同じ `runId` の再実行は同じ commit と `created: false` を返し、machine は同じ runId の checkpoint を直列化して二重 commit を作らない。
- **pack 転送**（0244）は `POST /rpc/checkpoint/<runId>/pack`、`content-type: application/x-git-pack`、`content-length` 必須、最大 **64MiB**（`MAX_CHECKPOINT_PACK_BYTES`。Artifacts の push 上限で、Worker の request 上限ではない）。署名は既存の 6 ヘッダで、`bodyHash` は **pack のバイト列**。成功は `{ ok: true, op: "pack", result: { runId, receivedBytes } }`、失敗は既存の refusal（`too_large` 413 / `invalid_request` 400 / `unauthorized` 401）。`content-length` が無い・数でない・負は `invalid_request`、64MiB 超は**本文を読む前に** `too_large` で、部分受信もしない（チャンクは保持しない）。
- **署名が content-type / content-length を覆わない**。どちらも本文を読む前に検証し、`content-length` と実バイトの一致を見てから署名を確かめるが、転送中の差し替えは原理的に見えない。よって受け口（0245）は、受け取った pack の sha256 が署名済みの `bodyHash` と一致することを**必ず**確かめ、一致しない pack は R2 に置かない。
- checkpoint（git）と pack upload は**deadline を分ける**（`timeoutMs` と `packUploadTimeoutMs`。既定 5 分）。**同時実行枠（`maxConcurrency`）は共有**する: pack の転送中は 1 枠を使い、上限に達していれば JSON の operation は待たずに `busy`（429）で返る。
- 上限（`maxResponseBytes` など）は refusal の `too_large` / `deadline_exceeded` で返し、**fail closed**。

## 変わったとき

署名のメッセージ・ヘッダ・語彙を変えるなら、`core/machine.ts` と `machine/src/wire.ts` と `server/src/do/machine.ts` とこのファイルを同時に。**バイト列の互換はリリース前なので管理しない**が、変えたら test（`signature.test` / `wire.test`）で固定する。

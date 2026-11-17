# 契約: machine（署名・ROOT 封じ込め・操作）

2026-11-18 / L6 M2 の続き。**この面の契約の正本**。実装は `@hns/core` の `machine.ts`（署名の形）と `@hns/machine`（agent / wire / operations / containment / refusal）、サーバ側は `server/src/do/machine.ts`。不変条件は [invariants.md](../invariants.md) の INV-01 / INV-02 / INV-03。

## 経路

- サーバ → machine は **1 つのルート `/rpc`**（`MACHINE_RPC_PATH`）。署名がこのパスを含むので、別のパスは受け付けない。
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
- 上限（`maxResponseBytes` など）は refusal の `too_large` / `deadline_exceeded` で返し、**fail closed**。

## 変わったとき

署名のメッセージ・ヘッダ・語彙を変えるなら、`core/machine.ts` と `machine/src/wire.ts` と `server/src/do/machine.ts` とこのファイルを同時に。**バイト列の互換はリリース前なので管理しない**が、変えたら test（`signature.test` / `wire.test`）で固定する。

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
- **exec**（0194 / D095）は `{ "op": "exec", "command"? | "args"?, "cwd"?, "timeoutMs"? }`。`command` か `args` のどちらかが必須で、`cwd` は ROOT 相対（既定は ROOT）、`timeoutMs` は要求の deadline を**短くするだけ**。成功は `{ exitCode, output }`（stdout と stderr を時系列に混ぜた UTF-8）で、非 0 終了も成功応答。**exec は sandbox の probe が起動時に通ったときだけ動く**。通っていなければ `forbidden`（403。sandbox 不在を表す語彙が他に無いため）で、host の shell では実行しない（fail closed）。stdout/stderr が `maxResponseBytes` を超えたら `too_large`（**切り詰めない**。切り詰めた転記は完全な転記に読めるため）、要求の deadline を超えたら `deadline_exceeded`、`cwd` が ROOT の外やディレクトリでなければ `invalid_request`。実行環境は bwrap で、**`<ROOT>` の下の兄弟（どの段の兄弟も）は見えず**、`.git` は読み取りのみ、machine の固定 hide リスト（`<ROOT>/.hns` を含む）は不可視、env は allowlist だけ（D095）。hide が効くのは**起動時に存在したパスだけ**で、無いパスは bwrap が tmpfs を作れず隠せない（残余の限界として記録）。

## レジストリ（0148 / D087）

machine の登録と到達性は **D1 のレコード**で保ち、接続を保持する DO は作らない（D049）。正本は `machines` と `machine_events`（migration 0008）。

- **2方向の鍵、秘密はそれぞれの側に**。machine → Worker は **device key**（Ed25519）。秘密は machine の 0600、**公開鍵は `machines.public_key`（32 バイトの BLOB）**。Worker → machine は **control-plane key**。秘密は Worker の secret（`HNS_CONTROL_PLANE_KEY`）、公開鍵は `GET /api/machines/keys` で machine に配る。どちらの秘密も反対側に出さない。
- **モデルの綴り**は `@hns/core` の `Machine`。`publicKey` は base64url（43 文字、パディングなし）の公開鍵で、**秘密は型に存在しない**。`fingerprint` は `ed25519:` + SHA-256 の先頭 16 バイト（hex）。
- **登録は人**。machine が `hns machine enroll` で device key を作って公開鍵と fingerprint を表示し、サインインした人が browser から `Mutation.registerMachine` に貼る。秘密は machine から出ない。machine が自分で登録する enrollment token はまだ無い（必要になったら短命・一度きり・保存は hash）。
- **同じ name + 新しい公開鍵は reimage**。同じ行の id を保ったまま鍵を差し替え、古い鍵を即時に無効化し、`machine_events` に旧 fingerprint と actor を1行残す。**同じ name + 同じ鍵は冪等**（何も書かない）。**revoked の name は再登録できない**（refusal は `revoked`、`name_taken` ではない）。
- **reimage できるのは、その machine を登録した operator だけ**（`machines.created_by` と actor の一致。B1）。鍵の差し替えは machine id・それを束縛した workspace・Worker の probe 先（hostname）を一緒に渡すので、別の operator の要求は `name_taken` で拒否し、何も書かない。
- **`publicKey` は一覧に載せない**（NB2）。一覧は `fingerprint` だけを返し、device 鍵の全体は `registerMachine` の応答にだけ載る。
- **登録者の subject も一覧に載せない**。`machines.created_by` は session の subject（人の identity）で、一覧は全ての session が読む。代わりに **`isMine`**（その要求をした session が登録したか）を返し、他人が登録した machine の owner は分からないようにする。operator が知る必要があるのは「自分が reimage できる machine か」だけである。
- **失効は即時**。`status = 'revoked'` は終端で、`deviceKey(id)` は revoked の machine に鍵を返さない。以後の署名は鍵が無いので検証で落ちる（fail closed）。
- **到達性は観測、状態は保存**。`status` は `online` / `offline` / `revoked` の閉じた語彙。probe は `/rpc` に `{"op":"health"}` を control-plane 署名で送る（0147 の agent の唯一のルート。`/health` というパスは無い）。成功は `online` / lastSeen、失敗は `offline`。**lastSeen の書き込みは 30 秒に 1 回まで**（`MACHINE_LAST_SEEN_THROTTLE_MS`）で、状態も lastSeen も変わらない probe は何も書かない。probe の契機は **`Query.machines` の読み取り時**（throttle）。定期 probe は 0161。
- **probe の呼び手は 0148 では一覧の読み取りだけ**。Worker→machine の transport（`server/src/machines/transport.ts`、control-plane 署名・timeout 3 秒・閉じた失敗）はここで実装するが、**Workspace DO が machine を呼ぶ配線（`op:mirror` と checkpoint の pack push）は 0249**。0246 の Result が「push の起動配線が無い」を 0249 の受入にしている。
- **一覧は D1 直**（`Query.machines`）。索引は作らない（D049）。
- **0245 が読む「記録済み machine」**は `machines` の行である。Workspace DO の `#checkpointMachine()` は現在の lease 保持者 → 記録済み machine の順に読み、`#deviceKey()` は `SELECT public_key FROM machines WHERE id = ?` でこの表を見る。0245 のテストが手で作っている `machines` の DDL は、0008 の実表に寄せるのが正しい（その寄せ替えは 0245 のレーンの follow-up）。

## 起動点（0270n）

machine を**人が 1 コマンドで起動**する: `hns-machine enroll --root <ROOT>`（公開鍵と fingerprint を出し、人が
`Mutation.registerMachine` に貼る）→ `hns-machine run --enrollment <output | file | ->`（`startMachineAgent` を起動）。
enroll の出力は run の入力そのもの。**enroll は既存の鍵を `--force` なしで上書きしない**（黙って reimage しない）。
**run は control-plane の公開鍵が無ければ起動しない**（全要求が拒否される機械を「起動した」と見せない）。
鍵は `<configDir>/device.json`（0700 / 0600）と `<configDir>/control-plane.json`、カウンタは `<configDir>/grants`。

## 変わったとき

署名のメッセージ・ヘッダ・語彙を変えるなら、`core/machine.ts` と `machine/src/wire.ts` と `server/src/do/machine.ts` とこのファイルを同時に。**バイト列の互換はリリース前なので管理しない**が、変えたら test（`signature.test` / `wire.test`）で固定する。

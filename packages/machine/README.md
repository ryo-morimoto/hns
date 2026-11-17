# @hns/machine

マシン側の常駐エージェント。cloudflared の後ろで `127.0.0.1` に待ち受け、署名付きの要求だけを受け、
ROOT の外に出さず、同時実行数・出力サイズ・時間に上限を置く。

## 使い方

```ts
import { startMachineAgent } from "@hns/machine";

const agent = await startMachineAgent({
  root: "/home/you/work",
  machineId: "machine-1",
  controlPlane: enrolledKeys, // enrollment で配られた control-plane 公開鍵（複数可）
  port: 8788,
});
console.log(agent.origin); // http://127.0.0.1:8788
```

inbound の要求は **control-plane の Ed25519 鍵**で検証する。秘密鍵は Worker の secret に置き、公開鍵は enrollment で
マシンに配る（ローテーションのため複数可）。マシンの **device key**（秘密はマシン 0600、公開鍵は D1 の Machine
レコード）は machine → Worker（登録・heartbeat・outbound）用で、inbound の検証には使わない（0148）。
cloudflared は外向きの接続を保ち、この agent へは `127.0.0.1` で届く。

## 要求

`POST /rpc` だけを答える。body は `{ "op": "health" | "stat" | "read" | "list", "path": "..." }` と、
版付き書き込みの `{ "op": "write", "projectRoot", "path", "expectedVersion", "operationId", "content" (base64), "contentHash" }`。
write は `projectRoot` と `path` を別々に検証し、ROOT の dirfd から各段を `O_NOFOLLOW` で辿り、現在の版を
再計算して `expectedVersion` と比べ、同一ディレクトリの temp を rename する。結果は `applied` / `conflict` /
`unknown` + `path`（@hns/core の `MachineWriteResult`）。

ヘッダ（すべて必須）:

| ヘッダ             | 意味                                           |
| ------------------ | ---------------------------------------------- |
| `x-hns-machine`    | Machine レコードの id                          |
| `x-hns-connection` | 接続インスタンスの id                          |
| `x-hns-seq`        | 接続インスタンスの連番（要求ごとには変えない） |
| `x-hns-timestamp`  | unix ミリ秒                                    |
| `x-hns-nonce`      | 16〜64 文字の base64url                        |
| `x-hns-signature`  | 署名メッセージへの Ed25519 署名（base64url）   |

署名は `signatureMessage()` が返す JSON 配列（版・machine・connection・seq・timestamp・nonce・method・path・body の sha256）に付ける。
署名するのは Worker で、この package は `verifyRequestSignature()` で検証だけを行う（Worker 側の実装は
`@hns/server` の `do/machine.ts`、鍵の配布・rotation は 0148）。`x-request-id` は署名対象ではない。

拒否は閉じた `RefusalCode` で返る。主なもの: `unauthorized` (401)、`stale_request` (401)、
`replayed` (409)、`stale_connection` (409)、`invalid_request` (400)、`path_denied` (400)、`forbidden` (403)、
`not_found` (404)、`method_not_allowed` (405)、`busy` (429)、`too_large` (413)、`deadline_exceeded` (408)。

## 不変条件

- 待受は `127.0.0.1` だけ。inbound のポートを開けない。
- 要求は「enrolled な control-plane 公開鍵のどれか」「±60 秒の時刻窓」「未使用の nonce」「現在の接続 seq」を
  すべて満たすときだけ通る。マシンの device key は inbound の資格情報ではない。
  nonce は署名が通ってから記録する（未認証の要求で nonce を焼けない）。
- パスは ROOT 相対に正規化する。`/` 始まりは ROOT 相対で、`..` は拒否する。親は canonical 化し、ROOT の外を指す
  symlink の親は拒否する。最終要素の symlink は read も list も拒否する（read は `O_NOFOLLOW`、list は `lstat`）。
  `stat` は追わず `kind: "symlink"` を返す。
- 残余の TOCTOU: 同じユーザーが `lstat` / 親の canonical 化と open の間に親を差し替えると、ROOT の外を読める・一覧できる。
  read は最終 symlink を、list は最終要素を拒否するが、この窓は dirfd helper（workspace と同じ。0194 / 0054）で閉じる。
  同一ユーザーを信頼境界にしない。
- write は `@hns/workspace` の `applyVersionedWrite` を使う（rooted-helper と同じ fd 走査）。`projectRoot` / `path` を
  別々に検証し、content hash と intent の一致を確かめてから書く。同じ root・path の write はこのプロセス内で
  直列化する。残余の窓は hash と rename の間の同名差し替え（Linux に compare-and-rename が無い）。
- 上限: 同時実行数（超えたら 429）、要求 body（413）、応答（413。切り詰めない）、1 要求の時間（408）。
  FIFO・device・socket は read しない（`O_NONBLOCK` の open と非 regular の拒否で thread pool を塞がない）。
- exec は出さない。sandbox が無い環境で exec を出さない（fail closed）。0194 で足す。書き込みは
  `write` op だけ（dirfd で ROOT の内側に限る）。
- 秘密（cloudflared token・control-plane の秘密鍵）をログにも応答にも出さない。マシンは control-plane の秘密鍵を持たない。

## 開発

```bash
npm test -w @hns/machine
npm run build -w @hns/machine
```

単体テストは `src/` の隣、実 HTTP のテストは `test/integration/`。設計は 0147、鍵の置き場所は
[auth.md](../../docs/auth.md) と D049。

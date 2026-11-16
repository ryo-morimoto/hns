# @hns/machine

マシン側の常駐エージェント。cloudflared の後ろで `127.0.0.1` に待ち受け、署名付きの要求だけを受け、
ROOT の外に出さず、同時実行数・出力サイズ・時間に上限を置く。

## 使い方

```ts
import { readDeviceKey, startMachineAgent } from "@hns/machine";

const agent = await startMachineAgent({
  root: "/home/you/work",
  machineId: "machine-1",
  keys: registry, // D1 の Machine レコードから公開鍵を返す（0148）
  port: 8788,
});
console.log(agent.origin); // http://127.0.0.1:8788
```

デバイス鍵はマシンに置く。秘密鍵は 0600 で、読めるのは本人だけ（`readDeviceKey` がモードを検査する）。公開鍵だけを
D1 の Machine レコードに置く。この agent は**受け取る側**なので署名はしない。マシンからの署名（Worker が D1 の
公開鍵で検証する向き）は 0148 で配線する。
cloudflared は外向きの接続を保ち、この agent へは `127.0.0.1` で届く。

## 要求

`POST /rpc` だけを答える。body は `{ "op": "health" | "stat" | "read" | "list", "path": "..." }`。

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
`signRequest()` / `verifyRequestSignature()` が同じ定義を使う。

拒否は閉じた `RefusalCode` で返る。主なもの: `unauthorized` (401)、`stale_request` (401)、
`replayed` (409)、`stale_connection` (409)、`invalid_request` (400)、`path_denied` (400)、`forbidden` (403)、
`not_found` (404)、`method_not_allowed` (405)、`busy` (429)、`too_large` (413)、`deadline_exceeded` (408)。

## 不変条件

- 待受は `127.0.0.1` だけ。inbound のポートを開けない。
- 要求は「登録された鍵」「±60 秒の時刻窓」「未使用の nonce」「現在の接続 seq」をすべて満たすときだけ通る。
  nonce は署名が通ってから記録する（未認証の要求で nonce を焼けない）。
- パスは ROOT 相対に正規化する。`/` 始まりは ROOT 相対で、`..` は拒否する。親は canonical 化し、ROOT の外を指す
  symlink の親は拒否する。最終要素の symlink は read も list も拒否する（read は `O_NOFOLLOW`、list は `lstat`）。
  `stat` は追わず `kind: "symlink"` を返す。
- 上限: 同時実行数（超えたら 429）、要求 body（413）、応答（413。切り詰めない）、1 要求の時間（408）。
  FIFO・device・socket は read しない（`O_NONBLOCK` の open と非 regular の拒否で thread pool を塞がない）。
- exec と書き込みは出さない。sandbox が無い環境で exec を出さない（fail closed）。0194 で足す。
- 秘密鍵・cloudflared token をログにも応答にも出さない。

## 開発

```bash
npm test -w @hns/machine
npm run build -w @hns/machine
```

単体テストは `src/` の隣、実 HTTP のテストは `test/integration/`。設計は 0147、鍵の置き場所は
[auth.md](../../docs/auth.md) と D049。

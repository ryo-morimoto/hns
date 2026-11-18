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

`POST /rpc` と、checkpoint の pack だけの `POST /rpc/checkpoint/<runId>/pack` を答える。body は `{ "op": "health" | "stat" | "read" | "list", "path": "..." }` と、
版付き書き込みの `{ "op": "write", "projectRoot", "path", "expectedVersion", "operationId", "content" (base64), "contentHash" }`。
write は `projectRoot` と `path` を別々に検証し、ROOT の dirfd から各段を `O_NOFOLLOW` で辿り、現在の版を
再計算して `expectedVersion` と比べ、同一ディレクトリの temp を rename する。結果は `applied` / `conflict` /
`unknown` + `path`（@hns/core の `MachineWriteResult`）。

checkpoint は `{ "op": "checkpoint", "runId", "committedAt"? }` で、`@hns/workspace` の `checkpointRun` を呼んで
`refs/hns/checkpoints/<runId>` を進め、**metadata だけ**（runId / ref / commit / packKey / objectCount / packBytes /
maxBlobBytes / created）を返す。pack は `POST /rpc/checkpoint/<runId>/pack`（`application/x-git-pack`、
`content-length` 必須、最大 64MiB）に、同じ署名ヘッダで body を pack のバイト列として送る。受け取った pack は
`onCheckpointPack` の sink に渡す（R2 への書き込みは Worker 側、0245）。

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
- **exec は sandbox の後ろだけ**（D095）。起動時に `detectSandbox()` が probe を通したときだけ `op: "exec"`
  が動く。通さなければ `forbidden`（403）で拒否し、**host の shell に落ちない**（fail closed。SKIP ではない）。
  `MachineAgent.shell` が `enabled` / `disabled` と理由を返す。
  - mount の形: `--ro-bind / /` → `--tmpfs <ROOT>` → 祖先を `--dir` → `--bind <project>` → `--ro-bind <project>/.git`。
    **ROOT の下（ROOT 直下の兄弟だけでなく、ROOT のどの段の兄弟も）は見えない**。tmpfs は「そのパスの下」を隠し、
    パス自身は親から見えるので、いちばん外側（ROOT の下に project があるなら ROOT）を mask し、その下を空の
    `--dir` で作り直す。`.git` は読めるが書けない（worktree の `.git` ファイルも同じ）。
  - hide は **machine の固定リスト**（`machineHideList`（`home`、`root`）: `~/.config/hns`、`~/.ssh`、`~/.aws`、
    `~/.config/gh`、`~/.git-credentials`、`~/.netrc`、`<ROOT>/.hns`）。呼び出し側から足せない。
    **起動時に存在するパスだけ**が隠れる: bwrap は read-only な親の下に無い名前へ tmpfs を作れず
    （`Can't mkdir parents ... Read-only file system`）、無い名前には隠す中身も無い。起動後に作った
    `~/.config/hns` は、その次の exec の時点で存在すれば隠れる（enroll は agent 起動前に作る）。
  - env は allowlist だけ: `PATH` / `HOME`（= ROOT、0045 H-1）/ `LANG` / `TERM` と、sandbox が固定する
    `TMPDIR=/tmp`、`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`=/dev/null、`GIT_OPTIONAL_LOCKS=0`。server の
    provider 鍵・provider URL・control-plane 鍵・cloudflared token は**渡らない**（テストで固定）。
  - egress: `deny`（既定）と `allowlist` は `--unshare-net`、`inherit` は host の network。
  - 出力は応答上限を超えたら `too_large`（切り詰めない）、時間切れは `deadline_exceeded`、cwd が ROOT の外なら
    `invalid_request`。
  - **seccomp は未接続**。フィルタ（io_uring / AF_VSOCK を EPERM）は `machineSeccompFilter` にあり単体でテストして
    いるが、`bwrap --seccomp` は継承した fd しか取らず、pi-durable の exec は子に stdio しか渡さないため、
    この配線では付けられない（付けると全 exec が "Can't read seccomp data" で落ちる）。fd を渡せる exec に入れ替える
    のが前提条件で、follow-up。
- 書き込みは `write` op だけ（dirfd で ROOT の内側に限る）。
- 秘密（cloudflared token・control-plane の秘密鍵）をログにも応答にも出さない。マシンは control-plane の秘密鍵を持たない。

## capability grant の検証（0225）

`@hns/machine` の `capability/` は、Session DO が発行した grant（0224）を**マシン自身で**検証して
許可 / 拒否を決める。Worker に毎回聞かないので、ツール呼び出しごとの往復が無い。

```ts
import { GrantCounter, authorizeGrantedCall, fetchControlPlaneKeys } from "@hns/machine";

const keys = await fetchControlPlaneKeys({ url, fetch, session }); // 0148 の鍵面から 1 回
const counter = new GrantCounter(join(homedir(), ".config", "hns", "grants"));
const { decision } = await authorizeGrantedCall({
  grant,
  call,
  manifest,
  keys,
  counter,
  machineId,
  now,
  activePolicy,
  bytes,
});
```

- **検証**（`verifyGrant`）: このマシン宛か → 契約の `authorizeCall`（署名 → alg → 失効 → 期限 → epoch →
  manifest / tool / version → scope → exact）→ 提示された `activePolicy` と `epoch` / `policyHash` の一致。
  結果は `PolicyDecision`（例外を投げない）。`activePolicy` を渡されなければ `policy_denied`（fail closed）。
- **鍵**: `GET /api/machines/keys`（0148）が配る control-plane の公開鍵を、**ホストのプログラムが**
  `fetchControlPlaneKeys` で取得して `startMachineAgent` の `controlPlane` に渡す（**`hns-machine run` は
  まだこの関数を使わない**：CLI は `--control-plane-key` の seed から公開 half を導出するか
  `<configDir>/control-plane.json` を読む。鍵面から取る口は follow-up）。machine はその鍵で
  grant の `keyId`（`sha256Hex(JCS(base64url(公開鍵)))` の先頭 32 hex）で選ぶ。**grant 応答の鍵は使わない**
  （TOFU にしない）。無い・読めない・不一致は `grant_invalid`。
- **カウンタ**: `<configDir>/grants/<grantId>.json`（0600、ディレクトリ 0700）に `calls` / `bytes` を置き、
  実行**前**にアトミックに消費する（JSON を temp に書いて rename、grant ごとの in-process lock）。再起動をまたいで
  数え、`maxCalls` / `maxBytes` を超えると `counter_exhausted`。読めない・壊れている・書けないは**拒否**
  （壊れた JSON は新しい予算にならない）。`~/.config/hns` は sandbox の hide（D095）なので、agent の
  exec からは読めない。
- **RPC への配線は 0226**。この節の関数を呼ぶだけの入口はまだ無い（`activePolicy` は制御チャネルが運ぶ）。

## CLI（0270n）

```bash
hns-machine enroll --root <ROOT> [--name <name>] [--machine-id <id>] [--url <https URL>] [--config-dir <dir>]
hns-machine run [--enrollment <file|->] [--config-dir <dir>] [--control-plane-key <seed>]... [--port <port>]
```

- **enroll** は device 鍵を `<configDir>/device.json`（ディレクトリ 0700・ファイル 0600）に作り、
  **公開鍵と fingerprint だけ**を JSON で出す。人が `Mutation.registerMachine` に貼る。既存の鍵が
  あれば `--force` なしでは**失敗**する（黙って reimage しない）。
- **run** は `startMachineAgent` を起動する。enrollment は `--enrollment`（ファイルか `-`）か、同じ
  configDir の device.json。control-plane の公開鍵は `--control-plane-key`（Worker の seed と同じもの。
  公開 half をここで導出する）か `<configDir>/control-plane.json`（`{ v: 1, publicKeys: [...] }`）。
  **どちらも無ければ起動しない**（全要求が拒否される機械を「起動した」と見せない）。
- enroll の出力は run の入力そのもの：`hns-machine enroll ... > e.json && hns-machine run --enrollment e.json`。

## 起動した / していない（0270n）

| 面                                                                        | 今この面は起動するか | 誰が呼ぶか                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| machine の agent（`startMachineAgent`）                                   | ✓                    | `hns-machine run`（人が 1 コマンド）                                                                                       |
| machine の enrollment（device 鍵と公開鍵）                                | ✓                    | `hns-machine enroll` → 人が `registerMachine` に貼る                                                                       |
| 署名付き health / probe（`/api/machines/keys` / 0148 の probe）           | ✓                    | `Query.machines` の読み（throttle）                                                                                        |
| signed wire（`/rpc` の read / write / checkpoint / mirror / exec）        | ✓                    | `Workspace` DO と `Session` DO の relay                                                                                    |
| capability grant の検証（0225）                                           | ✓                    | agent の `op: "tool"`（0226 の relay から）                                                                                |
| artifact mirror の push（0246）                                           | ✓                    | Workspace DO の complete の ack の後の `op:"mirror"`（0272n）。署名は `createSignedMachineFiles`、push は `pushCheckpoint` |
| exec の seccomp（0194）                                                   | ✗                    | 製品の exec に fd を渡す口が無い（0194 の Result の follow-up）                                                            |
| enrollment token（machine が自分で enroll）                               | ✗                    | 設計が未着手（0148 の follow-up）                                                                                          |
| `run` が `GET /api/machines/keys` から鍵を取る（`fetchControlPlaneKeys`） | ✗                    | CLI は seed か `control-plane.json` を読む。鍵面から取る口は follow-up                                                     |

## 開発

```bash
npm test -w @hns/machine
npm run build -w @hns/machine
```

単体テストは `src/` の隣、実 HTTP のテストは `test/integration/`。設計は 0147、鍵の置き場所は
[auth.md](../../docs/auth.md) と D049。

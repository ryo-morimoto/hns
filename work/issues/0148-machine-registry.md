# 0148: Machine レジストリ（D1 + fetch）

status: open
priority: now
design: agreed
design-ref: D087
depends-on: 0147, 0145, 0146, 0198
touches: packages/server/src/machines/, packages/core/src/machine.ts, packages/store/src/migrations/

## Goal

登録されたマシンと、いま届くかを D1 のレコードで保つ。
cloudflared は外向きの接続を維持する（D053）が、machine の状態は D1 のレコードで足りるので、接続を保持する DO は作らない（D049）。

## Acceptance criteria

- [ ] `Machine(id, name, hostname, publicKey, agentVersion, lastSeen, status)` を D1 に持つ。`publicKey` はマシンの device key（machine→Worker の検証に使う）
- [ ] 登録はブラウザのセッションから行い、公開鍵を保存する（秘密はマシンから出ない）
- [ ] 失効は即時に効く（以後の署名を拒否）
- [ ] 疎通は署名付きの health 呼び出しで確かめ、結果を遅延書き込みする（毎回の同期更新をしない）
- [ ] 同名・再イメージ・二重接続の扱いを決めてテストする
- [ ] 切断中の Run は park し、再接続で照合する（INV-04）
- [ ] control-plane の公開鍵を enrollment でマシンへ配る（秘密は Worker の secret。inbound の検証に使う）
- [ ] 一覧は D1 から直接引く（索引を作らない）

## Notes

- 接続は cloudflared のトンネル。ホスト名の管理はここ。
- PoC は固定の `AGENT_URL` 1本。DO を使っていないのがそのまま正しい形。
- 状態の更新（lastSeen）は書き込み回数が増えるので、間引く。
- 鍵は2種類。**machine の device key**（マシンの 0600 / 公開は D1）は machine→Worker の検証に、**control-plane 鍵**（秘密は Worker の secret / 公開は enrollment でマシンへ）は Worker→machine の検証に使う。0147 のキー分離の決定。

## 追記（0127 の識別子、2026-11-17）

- `workspaceId = projectId` を契約にする（専用 `workspaces` テーブルは作らない）。
- Machine に ROOT は持たせない（ローカル設定）。Workspace DO の最初の acquire が machineId と root を束縛する。
- migration の番号は landing 順に採る。0149 / 0127 と同じ週に着地させない（`store/src/migrations/index.ts` の末尾に同時に1行足すため）。

## Design（D087 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D087）。

### 前提

- 0147 は landed。machine は **control-plane の公開鍵**で Worker→machine の要求を検証し、machine 自身の要求は **device key** で署名する。0147 は `MachineKeyRegistry` interface だけを持ち、公開鍵の供給は 0148。
- cloudflared は外向き接続。Worker は tunnel のホスト名で machine に届き、machine は inbound ポートを開けない（D053）。
- D080: `workspaceId = projectId`。Workspace DO の acquire が machineId と root を束縛する。Machine に ROOT は持たせない。
- D049: machine は D1 のレコード + fetch。接続を保持する DO は作らない。

### 決定 1: D1 の machines（索引を作らない）

- `machines(id, name UNIQUE, hostname, public_key, agent_version, last_seen, status, created_at, updated_at)`。
- status は `online` / `offline` / `revoked` の closed union。`revoked` は終端。
- 一覧は D1 直（`Query.machines`）。machine 用の索引は作らない（D049）。

### 決定 2: 鍵は2方向、秘密はそれぞれの側に

- **machine → Worker**: device key（Ed25519）。秘密鍵は machine（0600）、公開鍵は `machines.public_key`。Worker は 0147 の `RequestVerifier` に 0148 の registry を渡して検証する。
- **Worker → machine**: control-plane key。秘密鍵は Worker の secret、公開鍵は `GET /api/machines/keys`（公開。古い鍵と新しい鍵を並べられる）で配る。machine は enroll 時に取り、0147 の `ControlPlaneKeys` に保持する。
- どちらの秘密鍵も反対側に出さない。**失効は `status = revoked`** で、registry が鍵を返さなくなり、以後の署名は即時に拒否される。

### 決定 3: 登録

- machine: `hns machine enroll` が device key を生成（0600）し、`{ name, hostname, publicKey, agentVersion }` を表示する（秘密は含まない）。
- browser: session + `Mutation.registerMachine(...)`（0198）。表示された公開鍵の fingerprint を見せる。
- `name` は一意。同じ name で新しい公開鍵を登録したら **reimage として鍵を差し替え**、古い鍵を即時に無効化し、イベントを1行残す。`revoked` の name は再登録できない（新しい name を使う）。

### 決定 4: 疎通

- Worker は `https://<hostname>/health` を control-plane key で署名して叩く（timeout 3s）。成功で `online` / lastSeen 更新（30 秒に1回までの遅延書き込み）、失敗で `offline`。
- probe は `Query.machines` の読み取り時に throttle して行う。定期 probe は 0161（Cron Triggers）に送る。
- 0148 は machine→Worker の heartbeat を持たない。machine からの要求は device key で検証する（0147 の registry）。

### 決定 5: 切断と park

- `offline` / lastSeen が古い → その machine を使う run は park（0156 / 0157）。復帰（probe 成功 / machine からの要求）で 0161 / 0157 が再開する。
- 0148 は状態と lookup だけを持ち、run の queue は持たない。

### 決定 6: 面と依存

- GraphQL: `Query.machines`、`Mutation.registerMachine` / `revokeMachine`（0198）。
- REST（machine 向け）: `GET /api/machines/keys`（control-plane の公開鍵）。health は 0147 の `/health`。
- `depends-on` に 0198（Mutation）を足す。0147 / 0145 / 0146 は既存。
- touches: `packages/core/src/machine.ts`、`packages/store/src/{migrations,repositories}/`、`packages/server/src/machines/`、`packages/server/src/graphql/`、`tools/deploy/`、tests。

### 決定（D087）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 登録の渡し方 | **決定（user）**: machine が表示した公開鍵 + fingerprint を browser が貼る（秘密なし） | 0147 / 0107 | 2026-11-17 |
| U-02 | 同じ name の再登録 | **決定（user）**: reimage として鍵を差し替え、古い鍵を即時無効 + イベント | 0148 | 2026-11-17 |
| U-03 | probe の契機 | **決定（user）**: 一覧読み取り時に throttle。定期は 0161 | 0161 | 2026-11-17 |
| U-04 | control-plane 公開鍵の配布 | **決定（user）**: 公開 `GET /api/machines/keys` | 0147 / 0143 | 2026-11-17 |
| U-05 | heartbeat を持たない | **決定（user）**: 持たない（Worker→machine の probe と machine の要求で足りる） | 0157 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | registerMachine → machines に1行。name 重複は拒否 | 高 | 受入1 |
| C2 | 同じ name + 新鍵 → 鍵が差し替わり、古い鍵の署名は即時拒否 | 高 | 受入3 |
| C3 | revoke → 以後の署名を拒否。一覧は revoked を返す | 高 | 受入3 |
| C4 | health 成功 → online / lastSeen。失敗 → offline | 高 | 受入4 |
| C5 | 30 秒以内の連続 probe → lastSeen の書き込みは1回 | 中 | 受入4 |
| C6 | revoked の name で再登録 → 拒否 | 中 | 受入5 |
| C7 | offline の machine を使う run → park（0148 は状態だけ） | 中 | 受入6 |
| C8 | `GET /api/machines/keys` は公開鍵だけで秘密を含まない | 高 | 受入3 |
| C9 | `npm run check` | 高 | — |

## Log

- 2026-11-17: D087 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

## やらないこと

- 新しいマシンの初期化（clone・鍵・ツール導入）。A' に上げる条件。
- 常駐サービスとプレビュー。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: DO をやめ、D1 + fetch に変更（D049）。
- 2026-11-17: 0147 のキー分離（control-plane 鍵 / device key）を受けて、registry が両方を供給することを AC と Notes に足した。touches の migrations パスを実パスに直した。

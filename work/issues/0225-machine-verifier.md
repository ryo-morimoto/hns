# 0225: Machine 側で grant を検証し、ローカルで許可/拒否する

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §5, §7
depends-on: 0220, 0148, 0194
touches: packages/machine/src/capability/verify.ts, packages/machine/src/capability/counter.ts, packages/machine/src/capability/decision.ts, packages/machine/src/capability/keys.ts, packages/machine/src/capability/verify.test.ts, packages/machine/src/capability/counter.test.ts, packages/machine/src/capability/keys.test.ts

## Intent

grant を発行しても、実行するマシンが検証しなければ意味がない。マシンは DO に毎回聞かず、署名・期限・epoch・manifest・scope・回数をローカルで確認する。これが 28ms/op を 5ms に下げる場所。

## Goal

`@hns/machine` に、grant の検証（pure）と、grant ごとの回数・byte の消費（stateful）を置く。RPC への配線は 0226。fixture の grant で、偽造・期限・epoch・scope・replay を全拒否する。

## Acceptance criteria

- [x] `verifyGrant(input)` が署名・alg・期限・epoch・manifestHash・tool/version・scope・exact を検証する
- [x] `consume(grantId, calls, bytes)` がアトミックに残量を減らし、超えたら `counter_exhausted`
- [x] 状態は `~/.config/hns/grants/` に置き、agent からは見えない。読めない・書けないは拒否
- [x] 検証結果は `PolicyDecision` で返し、例外を投げない
- [x] `lastEpoch` を保持し、`payload.epoch < lastEpoch` を `epoch_stale` にする
- [x] control-plane の公開鍵を 0148 の `GET /api/machines/keys` から取得し、`keyId` で選ぶ。無い・読めない・不一致は拒否
- [x] fixture の Ed25519 grant でテストする（Phase 1 は Ed25519 固定）
- [x] `npm test -w @hns/machine` と typecheck が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 正しい grant + 一致する call → verify → allow | 高 | S3 |
| C2 | 署名を 1 byte 変える / alg を入れ替える → deny（`grant_invalid` / `grant_algorithm_mismatch`） | 高 | 契約 §5 |
| C3 | 期限切れ / epoch 古い → deny（`grant_expired` / `epoch_stale`） | 高 | S3 |
| C4 | manifestHash / toolId / version が違う → deny（`manifest_mismatch`） | 高 | R1 |
| C5 | path が root 外 / bash が封筒外 / exact の callHash 不一致 → deny（`scope_exceeded`） | 高 | R2 |
| C6 | maxCalls=1 で 2 回 consume → 2 回目は `counter_exhausted` | 高 | replay |
| C7 | 状態ファイルが壊れている → deny（fail closed） | 高 | 契約 §5 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C5 | 固定 grant + 攻撃コーパス | unit | `packages/machine/src/capability/verify.test.ts` |
| T2 | C6–C7 | 故障注入（並行 consume / 壊れた JSON） | unit | `packages/machine/src/capability/counter.test.ts` |
| T3 | C1–C7 | 実ファイル + 2 プロセス | integration | `packages/machine/test/integration/` |

## Notes

- 純関数（署名・scope）と状態（カウンタ）を分ける。純関数は core の `authorizeCall` を使い、machine は counter と `lastEpoch` だけを持つ。
- `~/.config/hns` は 0194 の hide で agent から隠す。grant の状態も同じ扱い。
- OpenShell の binary identity / sandbox JWT の検証位置（信頼する側）を参考にする。hns の machine は信頼する側で、bwrap child は信頼しない。

## 未確定

- カウンタの保存形式（JSON + rename か SQLite か）。Phase 1 は JSON + rename + in-process mutex。
- `lastEpoch` の更新経路（0226 の制御チャネル）。未接続なら grant の TTL まで。

## やらないこと

- RPC / HTTP への配線（0226）。
- grant の発行（0224）。
- ポリシーの保存（0223）。

## Log

- 2026-11-17: 作成（D091）。
- 2026-11-18: 実装（lane-0225、HEAD f950f1d、branch issue/0225-machine-verifier）。`packages/machine/src/capability/` に verify / counter / keys / decision。`GrantPayload` に `policyHash` を足し、`authorizeCall` が `epoch` / `policyHash` を activePolicy と照合（lead 承認済みの契約追加）。Result は下。
## Result

- verdict: **実装完了・レビュー待ち**（lane-0225。HEAD f950f1d、base main 5396e1d）。
- **gate**: `npm run check` exit 0（**1440 passed / 1 skipped**、main は 1353。テストは減っていない）。commit は pre-commit gate（unit）通過済み。
- **実装**（`packages/machine/src/capability/`）:
  - `verify.ts`: `verifyGrant` — このマシン宛か（`machine_invalid`…ではなく `grant_invalid`）→ 契約の `authorizeCall`（署名 → alg → 失効 → 期限 → epoch → manifest / tool / version → scope → exact）→ 提示された `activePolicy` と `epoch` / `policyHash` の一致。`PolicyDecision` を返し、例外は投げない。`activePolicy` 未提示は `policy_denied`（fail closed）。
  - `counter.ts`: `GrantCounter.consume` — `<configDir>/grants/<grantId>.json`（dir 0700 / file 0600、temp + fsync + rename、grant ごとの in-process lock）。`maxCalls` / `maxBytes` 超過は `counter_exhausted`、**書かずに拒否**。再起動をまたいで数える（テストで別インスタンス／別プロセス）。壊れた JSON・読めない・書けないは拒否（新しい予算にしない）。id がパスを逃げる形は `grant_invalid`。
  - `keys.ts`: `grantKeyId` / `enrolledGrantKeys` / `fetchControlPlaneKeys`。`GET /api/machines/keys` の公開鍵を `keyId`（`sha256Hex(JCS(base64url(raw)))` の先頭 32 hex = 0224 の signer と一致）で選ぶ。grant 応答の鍵は使わない（TOFU にしない）。無い・読めない・alg 違いは拒否。
  - `decision.ts`: `authorizeGrantedCall` — verify → consume の順。検証が拒否したら消費しない（0226 が呼ぶ入口）。
- **契約の追加**（lead 承認）: `GrantPayload.policyHash` と `authorizeCall` の `activePolicy` 照合。epoch の再利用で古い scope が生き残らない。0224 の issuer、ledger、GraphQL `GrantView`、SDL（codegen）も追随。
- **実経路**: `test/integration/machine-verifier.test.ts` が **実 D1 の policy revision + 実 0224 issuer（実 control-plane 鍵で署名）+ 実 WebCrypto** の grant を machine の verifier に通し、allow / 期限切れ `grant_expired` / 旧 revision `epoch_stale` / `maxCalls` 超過 `counter_exhausted` / scope 外 `unsupported` / 失効 `grant_revoked` / 別 deployment の鍵を拒否、を実測（7 tests）。
- **mutation**（`test/security/verifier-mutation.test.ts`、5 tests）: 署名を検証しない（grant 自身の鍵を信じる）/ `expiresAt` を見ない / scope を見ない / `maxCalls` を見ない、の 4 種で **product の判定と変異体の判定が分かれる**ことを固定。counter は product の class に bound を注入して外す（実装の書き換えではなく product のパス）。
- **agent から見えない**: `test/security/verifier-state.test.ts` が 0194 の sandbox で exec し、`~/.config/hns/grants` が list / cat できないことと、その裏で machine は読めることを実測。
- **未確認 / 判断**:
  - **実運用の起動点はまだ無い**。`authorizeGrantedCall` を呼ぶのは 0226 の RPC 配線（と制御チャネルの `activePolicy` snapshot）。それまでは machine は grant を検証しない。
  - カウンタの**プロセス間**の窓: 書き込みは rename で原子的だが、2 プロセスが同時に読むと残量を二重に使える。machine は ROOT ごとに 1 プロセスなので実害は無いが、file lock は入れていない（`docs/capability.md` §5 に追記するかは 0226 で判断）。
  - gate の `cf dev` 依存 suite（workspace-do / session-do / remote-write）は**並列実行で inspector lock 待ちの 60s timeout に当たる**ことがある（単独では 19s で通る）。私の変更とは無関係。CI の retry 方針は [testing.md](../../docs/procedures/testing.md) の flaky 規則どおり別途（retry で隠さない）。
  - `grant_invalid`（別マシン宛）は `DENIAL_CODES` に専用 code が無いので流用した。専用 code を足すなら core の表と retry 表を同時に変える（0226 までに判断）。

## Result

- verdict: **PASS**（reviewer-0225。blocking 0 / 低 8）
- HEAD: c4ee727（main に ff 統合）。gate は exit 0（1440 tests / 1441、main で 66.5s）。
- 確認: `verifyGrant` は契約の `authorizeCall`（署名 / alg / 失効 / 期限 / epoch / manifest / tool / version / scope / exact）に委譲し、**machine が足すのは counter と提示された activePolicy だけ**。`PolicyDecision` を返し例外を投げない。**activePolicy は毎回の引数**で、grant に保存した snapshot は使わない（**古い snapshot で allow しない**ことを変異で確認）。**`GrantPayload.policyHash` を追加**して `epoch` と併せて policy を縛る（core / issuer / ledger / GraphQL / SDL に一貫）。
- **カウンタ**: `<configDir>/grants/<grantId>.json`（0700 / 0600、temp + fsync + rename、grant ごとの lock）。**超過は書かずに `counter_exhausted`**、**壊れた JSON は `unsupported` でリセットしない**、**再起動・別プロセスをまたいで数える**。
- **鍵**: `keyId` が 0224 の signer と一致（実測で同じ値）、**grant 同梱鍵を使わない**（TOFU にしない）。
- **agent から見えない**: 0194 の実 sandbox の exec で `~/.config/hns/grants` が list / cat 不可（machine 側は読める）。
- 実経路: 実 D1 revision + 実 0224 issuer + 実 WebCrypto で allow、期限 / 旧 revision / maxCalls / scope 外 / 失効 / 別鍵で deny。レビュアーが 6 種の変異を追加で実行（うち 1 種は冗長な二重防御で生存。挙動は変わらない）。
- 非 blocking: `allow だが consume 失敗` を型で区別しない / `mayRetry` の呼び出し元が無い / 状態を消せば予算が戻る（docs に明記）/ **プロセス間 lock は未実装（1 プロセス前提）** / 既存 dir の mode は再適用しない / `lastEpoch` は引数で受けるだけで machine 側に保持先が無い（0226 の制御チャネル待ち）/ 別マシン宛は `grant_invalid` に流用（専用 code 無し）/ C2 のテストが alg ではなく鍵欠落の経路を測っている。
- **実装した ≠ 起動する**: `authorizeGrantedCall` の製品呼び出しは 0 件。**起動点は 0226**（制御チャネルの activePolicy snapshot と RPC 配線）。

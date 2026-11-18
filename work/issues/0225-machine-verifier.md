# 0225: Machine 側で grant を検証し、ローカルで許可/拒否する

status: open
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

- [ ] `verifyGrant(input)` が署名・alg・期限・epoch・manifestHash・tool/version・scope・exact を検証する
- [ ] `consume(grantId, calls, bytes)` がアトミックに残量を減らし、超えたら `counter_exhausted`
- [ ] 状態は `~/.config/hns/grants/` に置き、agent からは見えない。読めない・書けないは拒否
- [ ] 検証結果は `PolicyDecision` で返し、例外を投げない
- [ ] `lastEpoch` を保持し、`payload.epoch < lastEpoch` を `epoch_stale` にする
- [ ] control-plane の公開鍵を 0148 の `GET /api/machines/keys` から取得し、`keyId` で選ぶ。無い・読めない・不一致は拒否
- [ ] fixture の Ed25519 grant でテストする（Phase 1 は Ed25519 固定）
- [ ] `npm test -w @hns/machine` と typecheck が通る

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
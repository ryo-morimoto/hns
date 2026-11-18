# 0246: Artifacts ミラー adapter（repo・token・push・状態）

status: done
priority: now
design: agreed
design-ref: D106 / 0243 / 0245 / work/research/cloudflare-artifacts.md
depends-on: 0245
touches: packages/server/src/artifacts/repos.ts, packages/server/src/artifacts/repos.test.ts, packages/server/src/edge/env.ts, packages/server/src/do/workspace.ts, packages/workspace/src/mirror.ts, packages/workspace/test/integration/mirror.test.ts, packages/machine/src/operations.ts, packages/machine/src/wire.ts, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts

## Intent

R2 を正本にしたまま、checkpoint を Artifacts にミラーして git remote とオフライン review を得る。repo のライフサイクル、短命 token、push、失敗の扱いを一箇所に閉じる。

## Goal

`env.ARTIFACTS` binding を使い、workspace ごとの repo を遅延作成して短命 write token を発行する。machine は token で `refs/heads/hns/run/<id>` に push し、結果を CheckpointRecord の mirror に記録する。失敗は R2 の ack を壊さない。

## Acceptance criteria

- [x] `ArtifactsRepos`（get-or-create / createToken / 参照確認）が `env.ARTIFACTS` の上にある
- [x] `ArtifactsRepoName` codec が workspaceId を Artifacts の命名規則（先頭英数・2〜63・`. _ -`）に写像する
- [x] Workspace DO が prepare で `MirrorTarget`（remote / token / expiresAt / ref）を返す。token は push 時間 + 余裕（例: 900 秒）
- [x] machine が `refs/heads/hns/run/<id>` に push する。push 後、Worker が binding の log で commit を確認する
- [x] mirror の状態を mirrored / skipped / failed（too_large / unauthorized / push_rejected / network / repo_unavailable）で記録する
- [x] `maxBlobBytes` が 32MiB 超、または `packBytes` が 64MiB 超の run は push せず skipped。review は machine fallback と表示する
- [x] 失敗しても R2 の checkpoint ack は成功のまま。再送は同じ commit で冪等
- [x] env の `ARTIFACTS_MIRROR` off で mirror を止められる（最小の kill switch。workspace override と metrics は 0249）
- [x] token をログ・イベント・URL に残さない

## テスト条件

- C1: Given 新しい workspace、When prepare、Then repo 名が codec を通り、fake binding で repo が作られ token が返る（リスク: 初期化・命名）
- C2: Given machine の push、When complete、Then binding の log に commit があり mirror=mirrored（リスク: 検証漏れ）
- C3: Given push 拒否、When complete、Then mirror=failed で R2 の ack は成功（リスク: ack を壊す）
- C4: Given 32MiB 超の file、When checkpoint、Then mirror=skipped で review fallback（リスク: 上限）
- C5: Given token、When ログ / イベント、Then 平文が出ない（リスク: 秘密）

## テスト設計

- T1: C1 / unit / fake `env.ARTIFACTS`（local simulator の統合は 0249）
- T2: C2 / integration / push + log
- T3: C3 / unit / failure path
- T4: C4 / unit / limit
- T5: C5 / unit / redaction

## Notes

- `tools/deploy` の wrangler は local Artifacts に 4.163.0+ が必要。`cf` の config は `bindings.artifacts` を使う。
- repo は workspace ごとに1つ。run は heads 配下の branch。独自 `refs/hns/*` は binding が解決できず fork でも運ばれない。
- push は machine が行う（git の child process）。Worker は token と検証だけ。
- local simulator の repo は本番と別。CI では `remote=false`。**観測・kill switch・ローカルシミュレータの統合は 0249**。

## 未確定

- U-01: repo を prepare で作るか、最初の push で作るか / 仮説: prepare / 影響: 失敗時の孤児 repo / 責任者: user / トリガー: 実装前
- U-02: 32MiB 超を LFS pointer に逃がすか、skip のままか / 仮説: skip（S3 は今決めない）/ 責任者: user / トリガー: 実際に頻発したら

## やらないこと

- Artifacts を正本にする（C）
- LFS の設計
- ミラーの UI

## Log

- 2026-11-17: 作成（D106）。

## Result

- verdict: **PASS**（reviewer-0246。初回 PASS + 低 8 → NB2/NB3/低 4/低 5 を修正して再レビュー PASS）
- HEAD: b4641b2（main に ff 統合）。gate は exit 0（1219 tests / 1220、main で 62.2s）。
- 確認: core に `ARTIFACTS_MAX_BLOB_BYTES`（32 MiB）と prepare 応答の `mirror`（一時値・`refs/heads/hns/run/<id>`）。**token は `GIT_CONFIG_KEY_0=http.<remote>.extraHeader` の env のみ**で、`GIT_TRACE*` / `GIT_CURL_VERBOSE` / `GIT_ASKPASS` / `GIT_DIR…` を除去、stderr は写像して破棄。**remote は https かつ host あり userinfo なしのみ**（git を起動する前に拒否、machine は計測より前）。`/rpc/checkpoint/mirror` の `mirrored` は **binding の log で commit を確認した後**に書き、遷移表の **`failed → mirrored`** で再送が収束する。失敗理由は binding の例外の写像（network / unauthorized / repo_unavailable、ref 不在は push_rejected）。
- 実経路: **ローカル https の smart-HTTP（git-http-backend + TLS + 自己署名 CA）**を remote にして push → ls-remote（完全な ref 名を 2 回、ちょうど 1 行）→ binding の log 相当 → `mirrored`。bare の `rev-parse` と記録 commit が一致。mutation N1〜N6 で検出力を確認。
- 非 blocking（follow-up）: **push の起動配線が無い**（face に `/rpc/checkpoint/mirror` が無い・Worker→machine の transport が無い・token の再発行口が無い。0249 の受入）/ openssl 不在の環境で https の integration を skip しない / docs（decisions・遷移表・`MIRROR_FAILURES`・workspace.md・machine.md）の追記が所有者待ち / machine の `mirror` の host を Worker が再比較しない / `UNSUPPORTED` の export 理由が弱い。
- **起動配線は 0249**。つまり**この面は main に載ったが、実運用ではまだ誰も起動しない**（BOARD で done でも実際には動かない）。

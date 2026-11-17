# 0224: Session DO の capability grant を発行・署名する

status: in-progress
priority: now
design: agreed
design-ref: D091, docs/capability.md §5, §9, §10
depends-on: 0220, 0223, 0148
touches: packages/server/src/do/session-grants.ts, packages/server/src/capability/signing.ts, packages/server/src/do/state.ts, packages/server/src/edge/env.ts, tools/deploy/cloudflare.config.ts, packages/server/src/do/session-grants.test.ts, packages/server/src/capability/signing.test.ts

## Intent

per-call の DO 認可は 28ms かかる。権限を毎回聞かずに、かつエージェントが広げられないようにするには、期限・範囲・回数を持つ署名付き grant を事前に発行し、マシンがローカルで照合するのが最小の解。Session DO は tool を実行する場所なので、Worker から渡された policy snapshot から grant を発行する。

## Goal

`createGrantIssuer({ policy, signer, clock })` を純粋なモジュールとして作り、`GrantRequest` から `SignedGrant` を作る。policy snapshot は Worker が send の RPC で渡す（Session DO は D1 を読まない）。grant はセッション × ツール × manifest × machine 単位で、TTL 30〜60 秒、`maxCalls` / `maxBytes` を持つ。epoch は policy の revision。

## Acceptance criteria

- [x] `issueGrant(input)` が `GrantRequest` と policy snapshot を valibot で parse し、`ToolPolicy.scope` を grant の scope にする
- [x] grant の `toolId` / `toolVersion` / `manifestHash` / `machineId` / `sessionId` を request と一致させ、不一致は `manifest_mismatch`
- [x] `expiresAt` は `issuedAt + ttl`（30..60 秒）。`maxCalls` は policy の値。`nonce` と `grantId` は UUID。`epoch` は snapshot の revision
- [x] Phase 1 は Ed25519 固定。Workers の WebCrypto で sign/verify を実測し、不可なら grant を発行せず fail closed。alg と鍵の不一致は `grant_algorithm_mismatch`
- [x] 署名は control-plane の鍵（0148 の Worker→machine 署名と同じ鍵）で行い、公開鍵は 0148 の `GET /api/machines/keys` で配る。grant 用に別鍵を作らない。鍵のローテーションは Phase 2
- [x] grant 応答に公開鍵を同梱しない（machine は設定の鍵で検証する）
- [x] ポリシーが拒否したら grant を発行せず、`PolicyDecision` を返す
- [x] Phase 1 は `exact` scope の要求を `unsupported` で拒否する（承認フローは Phase 2）
- [x] `GrantLedger` の interface（`record(grant)` / `revoke(grantId)`）を定義し、DO SQLite 実装は 0226 に渡す
- [x] `npm test -w @hns/server` と typecheck が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 既定ポリシー → read_file の grant → 署名が検証でき、scope は read root | 高 | S3 |
| C2 | bash 無効のポリシー → bash の grant → 発行せず `tool_disabled` | 高 | 契約 §6 |
| C3 | request の manifestHash を変える → `manifest_mismatch` | 高 | R1 |
| C4 | Ed25519 → 署名 → 検証が通り、alg を入れ替えると拒否 | 高 | 契約 §5 |
| C5 | snapshot の revision が古い / 新しい → epoch が snapshot の revision になる | 高 | S3 |
| C6 | 同じ request を 2 回 → grantId と nonce が別 | 中 | replay |
| C7 | 不正な body（キー欠落・型違い）→ 拒否、grant を発行しない | 中 | 境界 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C3 | fake policy + fake signer | unit | `packages/server/src/do/session-grants.test.ts` |
| T2 | C4 | Ed25519 の鍵ペア | unit | `packages/server/src/capability/signing.test.ts` |
| T3 | C5–C6 | 時刻・revision の固定 | unit | 同上 |
| T4 | C7 | 境界値 | unit | 同上 |
| T5 | C1–C7 | 実 WebCrypto + 実 Session DO | integration | `packages/server/test/integration/` |

## Notes

- Worker は D1 の active policy を読み、send の RPC に `{revision, hash, document}` を載せる。Session DO はそれを保持し、モデルには渡さない。
- 署名の秘密鍵は Session DO の env。control-plane の鍵（0148）を使い、公開鍵は `GET /api/machines/keys` で配る。鍵のローテーションは Phase 2。
- Workers で Ed25519 が使えない場合、Phase 1 は grant を発行しない（fail closed）。ECDSA は鍵の配布を含めて Phase 2。`alg` は payload に含めて署名する。
- grant は per-call ではなく TTL の間キャッシュされる。per-call の DO 往復を消すのが目的（[研究](../../work/research/tool-call-fastpath-security.md) §5.1）。
- OpenShell の sandbox JWT / generation 束縛を、grant の epoch（= policy revision）と期限に対応させる。

## 未確定

- `packages/server/src/do/state.ts` は L1 の 0203（session 配線）と共有する。同時に流さない。

- Worker secret の形式（PEM / JWK / raw）。WebCrypto の import に合わせて 0224 で決める。
- 鍵のローテーションと複数 keyId の扱い。Phase 1 は 1 鍵。
- `maxBytes` の単位（モデルに返す JSON の byte か、ツール出力の byte か）。契約はモデルに返す JSON の byte とする。
- Session DO が保持する policy snapshot の更新契機（send ごとか、policy 変更の push か）。0226 で決める。

## やらないこと

- マシン側の検証（0225）。
- ツール実行への配線、DO SQLite の ledger、Worker からの snapshot 渡し（0226）。
- egress の grant（Phase 2）。

## Log

- 2026-11-17: 作成（D091）。発行元を Workspace DO から Session DO に変更（D1 を DO から読まない）。

## Result

- verdict: **PASS**（reviewer-0224。blocking 0 / 低 7。未検出の mutation 2 件は統合前にテストで塞いだ）
- HEAD: b6a736b（main に ff 統合）。gate は exit 0（1353 tests / 1354、main で 65.3s。1 回目は test 段で落ち、再実行で green）。
- 確認: 承認済み policy revision から `issueGrant` が `SignedGrant` を作り、**control-plane 鍵（Ed25519）で署名して自己検証してから返す**（不可なら発行しない）。`keyId` は公開鍵の fingerprint。**policyHash を再計算**し、`tool_disabled` / `exact` は発行しない / manifest 不一致 / TTL 30–60・maxCalls・maxBytes・期限の範囲 / alg 不一致を拒否。`maxBytes` は manifest の上限に clamp し、**未指定は manifest の上限**。
- **失効**: `DENIAL_CODES` に `grant_revoked` を足し、**期限より先に判定**（期限切れと区別）。run 束縛の grant は abort / close で revoke し、**失敗は `grant.revoke_failed` を監査と観測に残す**。
- **境界**: Session DO の `POST /rpc/grants` は公開 route でなく、Worker が **session token と subject** を提示して一致を検査（不一致は `forbidden_internal`/401）。**Worker は `@hns/agent` を import しない**（manifest の解決は object 側）。
- 実経路: 実 D1 の revision → 発行 → 実 WebCrypto で `authorizeCall` allow → 承認で revision 2 に進むと `path_outside_root` → run の revoke で `grant_revoked`。mutation 5 種 + 追加 4 種の検出。
- 非 blocking / follow-up: **project / machine の所有権は認可に使っていない**（認証済みなら誰でも任意の project を名指せる。`docs/contracts/auth.md` に明記。follow-up: `isMine` を resolver の認可に使う）/ GraphQL の scope が string のまま（契約の union を写す）/ 実運用の起動点は GraphQL の `requestGrant` のみで、**agent の自動発行は 0226**。

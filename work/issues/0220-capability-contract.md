# 0220: capability 契約（canonical call・grant・policy 型）

status: done
priority: now
design: agreed
design-ref: D091, docs/capability.md §3–§4
depends-on: -
touches: packages/core/src/capability/, packages/core/package.json, packages/core/tsdown.config.ts, packages/core/README.md, packages/core/CHANGELOG.md, docs/packages.md

## Intent

モデルがツールを呼ぶとき、その定義・引数・権限を同じバイト列で扱えない。OpenShell は MCP のヘッダー/body 一致と binary identity で呼び出しの同一性を作っているが、hns のツールは型付きなので引数まで縛れる。まず契約を `@hns/core/capability` に置き、agent / server / machine が同じ型で並列に実装できるようにする。

## Goal

`@hns/core/capability` に、ツールマニフェスト・呼び出し・grant・ポリシー・denial code の型と valibot schema、JCS、ハッシュ、grant 検証、能力集合の代数、review token を置く。新しい依存は足さない。

## Acceptance criteria

- [x] `ToolManifest` / `ToolCall` / `CallDigest` / `CapabilityScope` / `GrantPayload` / `SignedGrant` / `PolicyDocument` / `PolicyRevision` / `PolicyProposal` / `PolicyDecision` / `AuditEvent` を export する
- [x] `canonicalize`（RFC 8785 JCS）と `argsHash` / `callHash` / `manifestHash` / `policyHash` / `reviewToken` を実装する
- [x] valibot の strict schema で未知キー・型違い・欠落を拒否する
- [x] `authorizeCall` が署名・alg・期限・epoch・manifest・scope・exact を検証する（Ed25519 と ECDSA-P256 の両方）
- [x] `capabilityAtoms` / `diffPolicy` / `isUnder` を実装し、glob と未知の形は `unsupported` にする
- [x] `DENIAL_CODES` を閉じた union にし、各 code の再試行可否を表で持つ
- [x] `packages/core` の `exports` と `tsdown` の entry に `./capability` を足す
- [x] `npm test -w @hns/core` と `npm run typecheck -w @hns/core` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | RFC 8785 のベクタ → canonicalize → 期待値と一致する | 高 | S4 |
| C2 | 未知キー / 重複キー / `undefined` → parse → ValiError | 高 | 契約 §3 |
| C3 | Unicode、整数、`/a/b`、`..`、symlink 風の文字列 → callHash → 同一入力で安定し、入力が違えば変わる | 高 | S4 |
| C4 | 同じ args で args の順序だけ違う → canonicalize → 同じ hash | 高 | JCS |
| C5 | 偽造署名 / 期限切れ / epoch 古い / alg 不一致 / manifest 不一致 / scope 外 → authorizeCall → 各 denial code | 高 | S3 |
| C6 | base に含まれる candidate / 追加だけ / 削除だけ / 両方 / glob → diffPolicy → narrowing / expansion / mixed / unsupported | 高 | S10 |
| C7 | 同じ入力 → reviewToken → 同じ値。credential fingerprint を変える → 変わる | 中 | S11 |
| C8 | DENIAL_CODES の全要素 → switch → 全分岐があり `never` に落ちる | 中 | 型規律 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1, C4 | ゴールデンベクタ | unit | `packages/core/src/capability/canonical.test.ts` |
| T2 | C2 | 境界値 + 異常系 | unit | `packages/core/src/capability/schemas.test.ts` |
| T3 | C3 | プロパティ風コーパス | unit | 同上 |
| T4 | C5 | 故障注入（署名・時刻・epoch） | unit | `packages/core/src/capability/grant.test.ts` |
| T5 | C6, C7 | 差分表 + 固定ベクタ | unit | `packages/core/src/capability/policy.test.ts` |
| T6 | C8 | 型検査 + switch | unit | `packages/core/src/capability/denial.test.ts` |

## Notes

- OpenShell の MCP L7（ヘッダー/body 一致、重複・hop-by-hop 拒否）を、hns では canonical call に対応させる。binary identity の SHA-256 pin はマニフェストのハッシュに対応するが、**コードのハッシュではなく契約のハッシュ**とする（[capability.md](../../docs/capability.md) §4）。
- 参考: Codex の permission profile、Claude Code の deny 全モード、Progent の引数規則。Progent の「狭めるのは自動・広げるのは承認」は 0223 の差分分類に使う。
- 署名の実装は 0224。ここでは `CryptoKey` を受ける `verifyGrant` まで。鍵の保存はしない。

## 未確定

- Ed25519 が Workers の WebCrypto で使えるか。契約は両方を持ち、0224 の実測で既定を決める。
- JCS の数値表現の境界（safe integer 外）。Phase 1 は safe integer だけを受け、外は `unsupported` とする。

## やらないこと

- 鍵の生成・保存、HTTP、DB。
- grant の発行、監査の保存、ポリシーの承認（0222–0229）。
- glob の意味論。Phase 1 は拒否する。

## Log

- 2026-11-17: 作成（D091）。契約は [capability.md](../../docs/capability.md)。
- 2026-11-17: ユーザー判断で `next` から `now` へ（依存なし）。

## Result

- verdict: **PASS**（reviewer-0220。blocking 0 / 低 8）
- HEAD: be9cb43（main に ff 統合）。gate は exit 0（990 tests / 1 skip、main で 79.8s）。
- 確認: 11 型 + strict schema（v.GenericSchema、未知キー・型違い・欠落で ValiError）、JCS（RFC 8785 のベクトル、UTF-16 のキー順、-0 → 0、1e21 以上・孤立サロゲート・非 safe integer は throw）、argsHash / callHash / manifestHash / policyHash / reviewToken、authorizeCall（P-256 を実 WebCrypto で署名→検証、Ed25519 は Node 24 に subtle が無く skip）、capabilityAtoms / diffPolicy / isUnder（* / ** のみ、unsupported は allow に倒れない）、DENIAL_CODES / DENIAL_RETRY（表に無い code はコンパイルエラー）。
- **判断**: C2 の重複キーは JSON.parse で畳まれた後なので schema では証明できない。**境界の parse（0221 の machine RPC、0224 の grant 発行）の責務**とし、canonicalize の TSDoc に 1 行足す。PolicyDiffKind の unsupported は契約 §6 に照らして正しい（0228 の GraphQL enum もこれを写す）。
- 非 blocking（低 8）: isUnder("a","*") が unsupported ではない / -0 分岐のデッドコード / epoch 等の上限が schema で固定されない / 公開 export が 25 個広い（sha256Hex と *Schema は 2 つ目の利用者まで待つ） / 呼び出し側不備が manifest_mismatch に混ざる / 偽造テストの二重呼び出し / tsdown の platform: node と node: 混入検出 / docs/packages の issue 番号（所有者待ち）。
- 次: 0221（machine RPC input の canonical call）/ 0223（policy revisions）/ 0225（machine verifier）がこの契約を使う。

# 0243: Artifacts B の契約（core 型・pack wire・ReviewSource）

status: done
priority: now
design: agreed
design-ref: D106 / docs/durability.md §5 / work/research/cloudflare-artifacts.md
depends-on: -
touches: packages/core/src/checkpoint.ts, packages/core/src/review.ts, packages/core/src/index.ts, packages/core/src/checkpoint.test.ts, packages/core/src/review.test.ts, packages/server/src/review/source.ts, packages/server/src/review/source.test.ts, packages/server/src/checkpoint/transport.ts, packages/server/src/checkpoint/transport.test.ts

## Intent

D106 で R2 正本 + Artifacts ミラー（B）を決めた。0244 以降を並列に実装すると型・wire・読み取り interface がばらけるため、最初に共有契約だけを固定する。

## Goal

core に checkpoint / mirror / pack wire の型と schema、review read の型を置く。server に storage 非依存の ReviewSource と、pack 受け口の transport port を置く。挙動は実装しない。

## 公開契約

- `MIRROR_STATUSES` = pending / mirrored / skipped / failed。`MIRROR_FAILURES` = too_large / unauthorized / push_rejected / network / repo_unavailable / unknown。
- `MIRROR_TRANSITIONS`: pending → mirrored / skipped / failed、failed → pending（再試行のみ）。mirrored / skipped は終端。
- `MirrorState`（永続） = status + failure? + updatedAt。**token を持たない**。
- `MirrorTarget`（一時） = remote / token / ref / expiresAt。保存・ログ・イベントに出さない。
- `CheckpointRecord` = runId / ref / commit / packKey / objectCount / packBytes / maxBlobBytes / mirror。
- `MAX_CHECKPOINT_PACK_BYTES` = 64 MiB。`CHECKPOINT_PACK_CONTENT_TYPE` = application/x-git-pack。
- `CheckpointPrepareResult` と `CheckpointPackUploadResult` の wire schema。pack は JSON に含めない。
- `ReviewCommit` / `ReviewTreeEntry` / `ReviewFile` と `REVIEW_FAILURES`。`ReviewSource` は commit id を受ける（ref 名ではない）。

## Acceptance criteria

- [x] `packages/core/src/checkpoint.ts` に mirror / pack wire の型と schema がある
- [x] `packages/core/src/review.ts` に review read の型がある（checkpoint と同居させない）
- [x] `ReviewSource` interface（log / readTree / readFile）と fake 実装がある
- [x] `CheckpointPackTransport` port（upload / maxBytes）が server にある
- [x] `MirrorTarget` を `CheckpointRecord` に入れられない型になっている
- [x] 遷移表は全状態 + never で網羅される
- [x] typecheck と unit test が通る。binding / R2 / Artifacts には触らない

## テスト条件

- C1: Given 未知の mirror status、When schema parse、Then ValiError（リスク: 語彙の拡散）
- C2: Given MirrorTarget、When CheckpointRecord を作る、Then token を渡せない（型）
- C3: Given pending の MirrorState、When failed へ、Then 遷移表が拒否しない。mirrored から failed は拒否（リスク: 状態機械）
- C4: Given ReviewSource の fake、When commit id で log / readTree / readFile、Then 型どおり（リスク: interface 不足）
- C5: Given pack の上限、When 64MiB 超、Then too_large（リスク: Workers の上限）

## テスト設計

- T1: C1 / unit / schema
- T2: C2 / unit / type-level + runtime（satisfies ではなく parse）
- T3: C3 / unit / transition table
- T4: C4 / unit / fake source
- T5: C5 / unit / limit

## Notes

- **この issue が最初**。0244〜0249 はこの型を使う。
- ReviewSource は server の port。実装（Artifacts binding / R2）は 0247 / 0248。
- pack の受け口は 0245。0244 は client と wire のみ。
- core は model が正本。schema は型に合わせる（`v.GenericSchema<unknown, T>`）。

## 未確定

- U-01: ReviewSource の readFile が bytes か text か / 仮説: bytes + content type / 影響: UI / 責任者: user / トリガー: 0248
- U-02: MirrorState に commit を入れるか / 仮説: CheckpointRecord 側に持つ / 影響: 二重管理 / 責任者: user / トリガー: 実装前

## やらないこと

- R2 / Artifacts の adapter
- machine の checkpoint 操作
- GraphQL / UI

## Log

- 2026-11-17: 作成（D106）。
- 2026-11-17: レビュー B1/B4/B5/B6 を反映（pack wire・一時型・packBytes/maxBlobBytes・遷移表・core/review.ts 分割）。

## Result

- verdict: **PASS**（reviewer-0243。mutation probe で C1 / C3 / C4 / C5 が壊した実装を検出し、C2 は tsrs が型の破れを検出することを確認）
- HEAD: d20a5d4（main に ff 統合）。gate は exit 0（950 tests）。
- 確認: core の checkpoint / review、server の ReviewSource と CheckpointPackTransport。MirrorTarget（token）は CheckpointRecord / MirrorState の型と parse の両方で入らない。遷移表は全状態 + never。64 MiB ちょうどの通過と +1 の拒否。
- 非 blocking（低 8）: MirrorState の failed と failure の組み合わせが任意 / schema が mirror と record を突き合わせない / ReviewFileSchema が無い / assertPackFits が呼び出し側の limit を許す / fake の log が commit の形を検証しない / source が throw で失敗を返す / fake が unavailable 等を答えない（0247 まで） / TSDoc に他 issue 番号。
- 次: 0244（machine checkpoint）・0245（workspace オーケストレーション）・0247（review read）がこの型を使う。

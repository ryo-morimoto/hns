# 0193: backlog のメタデータを現在に合わせる

status: open
priority: later
design: agreed
design-ref: 設計を変えない（メタデータ整合）
depends-on: 0141, 0146
touches: work/, docs/, AGENTS.md

## Goal

`touches` / `depends-on` / BOARD を実態に合わせる。存在しないパスを持つ `touches` は「偽の非衝突」を生み、
レーン設計（D060）を壊す。

## Problem / context

- `packages/core/src/http.ts` と `http-schemas.ts` は 0188 で削除済み。約20 issue の `touches` がまだ指している。
- `packages/store/src/migrations/d1/` は存在しない（migration は 0189 で版ファイルに割れる）。
- 0149 は 0150 だけで足りる顔をしているが、AC は Session DO の書き込みを要求する（実質 0146）。
- 0158 は 0022–0026（PoC 時代の done）を前提にしているが、製品側の `@hns/store/identity`（0048）が無い。
- 0032（6パッケージへの移植）は、machine 以外が揃って実質終わっている。

## Acceptance criteria

- [ ] `core/src/http.ts` / `http-schemas.ts` を指す `touches` を実在パスへ直す（0065, 0116, 0117, 0120, 0121, 0123–0128, 0130, 0131）
- [ ] `store/src/migrations/d1/` を指す `touches` を 0189 後の実パスへ直す（0148, 0151, 0169）
- [ ] `depends-on` を実態に合わせる（0149 → 0146, 0150, 0189、0158 → 0048/0069/0070/0147/**0189**、0176 → 0189）
- [ ] 0149 の AC と `touches` に 0189 の provider seam（isolate 初回 open）と、migration 失敗を `requestId` 付きで記録する責務を足す
- [ ] 0032 を閉じる（machine だけ 0147 に残し、Reason を1行）
- [ ] 0173 を消化する（AGENTS.md の machine、docs/packages.md の server 依存、docs/engineering.md の層）
- [ ] BOARD の now 表・優先度マトリクス・計画表を issue の frontmatter と一致させる（照合手順を1つ決める）
- [ ] `npm run check`

## Notes

- 分類表は作らない（0182 の判断）。パスの付け替えだけ。
- `docs/decisions.md` は append-only。訂正は新しい決定。
- 0141 の `touches` から `work/BOARD.md` / `work/LANES.md` は外し、lead 所有に戻した（2026-11-11）。
- BOARD の照合は、frontmatter から数える小さなスクリプト（`tools/` の外、`work/` 配下）で足りる。

## やらないこと

- 優先度の変更（人が決める。D054）。
- 本文の書き換え（append-only の Log を除く）。
- 0035 / 0037 / 0050 / 0052 / 0062–0064 / 0118 など `superseded` の issue。

## Log

- 2026-11-11: 作成。0141 / 0146 の並行中に、`touches` の偽の非衝突がレーン設計を壊すため。

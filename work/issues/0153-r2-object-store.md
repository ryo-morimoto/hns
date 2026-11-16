# 0153: R2 オブジェクトストア（git object 互換・pack アップロード）

status: done
priority: now
design: agreed
design-ref: D048, docs/durability.md §1・§5
depends-on: 0141, 0144
touches: packages/workspace/src/objects.ts, packages/workspace/src/objects.test.ts, packages/workspace/src/index.ts, packages/workspace/package.json, packages/workspace/tsdown.config.ts, packages/workspace/test/integration/objects.test.ts, packages/server/src/edge/env.ts, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts, docs/durability.md, work/issues/0153-r2-object-store.md

## Goal

ワークスペースの内容を R2 に置く。key は git の object id とし、checkpoint の commit から辿れる形にする。

## Acceptance criteria

- [x] ファイル内容は blob として content-addressed に保存（key = object id）
- [x] checkpoint は pack 1個のアップロードにまとめる（1 Run = 1 Class A を目標）
- [x] ack 済み保存は content を R2 に置いてから返す（0141 の ack 定義）
- [x] 復元に必要な object の一覧を commit から辿れる
- [x] 重複排除（同じ content は 1 回だけ）
- [x] object lock（bucket lock）の設定を手順化する。R2 に bucket versioning が無いことを踏まえ、上書きは key の設計（content-addressed・既存 key は書かない）で防ぐ

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 内容 → object id を計算 → 既知の git blob id と一致（空・"hello\n"・"hello world"）。tree は blob と同じ内容でも別の id | 高 | 受入1 |
| C2 | 同じ内容を2回 put → bucket への put は1回、返る id は同じ | 高 | 受入5 |
| C3 | put の最中（bucket.put が未解決）→ 呼び出し元はまだ解決しない。bucket が受けた後に解決する | 高 | 受入3・0141 の ack 順序 |
| C4 | bucket.put が null（R2 の拒否）→ Error を投げ、成功として返さない | 高 | 受入3、fail closed |
| C5 | 存在する id の get / head → 保存した bytes と size。存在しない id → null | 中 | 受入1（get / head） |
| C6 | list が cursor で2ページに分かれる → 2ページ目の key まで全件返す | 中 | 受入1（list） |
| C7 | 同じ object 集合を順序を変えて buildPack → bytes と id の並びが一致（決定的） | 高 | 受入2 |
| C8 | 同じ内容を2つ含む集合 → pack の object 数は1（重複排除） | 高 | 受入5 |
| C9 | pack → 先頭が "PACK"・version 2・object 数、末尾の SHA-1 が本文の SHA-1 | 中 | 受入2、git が読める形式 |
| C10 | commit を1つ持つ集合 → `checkpoints/<commit>.pack` に put 1回。同じ commit が既に head にある → put しない（uploaded false） | 高 | 受入2（pack 1個） |
| C11 | commit が 0 個 / 2 個の集合 → Error（checkpoint の commit が決まらない） | 中 | 受入2・4（commit から辿れる） |
| C12 | 実 R2 binding（cf dev）で put → get → head → list。同じ内容を2回 put しても `objects/` の key は1つ | 高 | 受入1・5 |
| C13 | 実 R2 binding に上げた pack を git index-pack が受け付け、commit → tree → blob を git cat-file / rev-list で辿れる | 高 | 受入2・4 |
| C14 | 全変更 → `npm run check` → exit 0 | 高 | Result |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 同値分割（既知の git ベクタ） | unit | `src/objects.test.ts` "hashes an object exactly as git does" |
| T2 | C2 | 状態遷移（既存 key の再 put） | unit（fake bucket） | "writes the same content to the bucket once" |
| T3 | C3 | 順序（未解決 promise） | unit（fake bucket） | "a put resolves only after the bucket accepted it" |
| T4 | C4 | 故障注入（put が null） | unit（fake bucket） | "throws when the bucket refuses a write" |
| T5 | C5・C6 | 契約（往復・cursor） | unit（fake bucket） | "reads back stored objects and reports a missing id as null" / "follows the cursor when the bucket pages a listing" |
| T6 | C7・C8・C9 | 決定性・同値分割・境界（ヘッダ / trailer） | unit | "builds the same pack from any order of the same objects" / "packs one entry per distinct object" / "stamps the pack with its version, count, and SHA-1 trailer" |
| T7 | C10・C11 | 状態遷移・境界（commit 数） | unit（fake bucket） | "uploads one pack keyed by the checkpoint commit" / "refuses a set that does not carry exactly one commit" |
| T8 | C12 | 契約（実 binding） | integration（cf dev / 実 workerd） | `test/integration/objects.test.ts` "the R2 binding stores and lists blobs by object id" |
| T9 | C13 | 契約（git との互換） | integration（cf dev + git） | "... a checkpoint pack is readable by git" |
| T10 | C14 | ゲート | static / build | `npm run check` |

R2 の書き込み回数（Class A）そのものはテストで数えない。回数は「1 checkpoint = put 1回」という設計（C10）と、重複排除が put を省くこと（C2・C10）で抑える。

## Design

- key は git の object id。個別の object は `objects/<id>`、checkpoint は commit から辿れる object を1つの pack にまとめて `checkpoints/<commit>.pack`。
- object id は `SHA-1("<type> <len>\0" + content)`。Node と Worker の両方で動くよう `crypto.subtle.digest` を使う。
- zlib は `CompressionStream("deflate")` に閉じる（Node 24 と workerd の両方にある）。pack は git v2（object を id 順に並べ、trailer は本文の SHA-1）。
- 重複排除は2段。同じ内容は同じ key になるので、書く前に head で存在を確かめて省く。pack の中でも同じ id は1回だけ入れる。
- put は bucket の put が成功してから返す（R2 → 次の段、0141 の ack 定義）。null は成功として扱わない。
- R2 binding は `OBJECTS`。`packages/server/src/edge/env.ts` に構造的な型を置き、`tools/deploy/cloudflare.config.ts` で bucket を配線する。

## Notes

- コストは容量ではなく書き込み回数で決まる。個別 PUT を避ける。
- R2 をファイルシステムとしてマウントしない（rename が原子でなくなる）。

## やらないこと

- restore の実装（0155）。
- .git 全体の同期（必要になったら別 issue）。
- R2 の bucket versioning の有効化。R2 にまだ無い（2026-11 時点）。上書きは key の設計で防ぎ、消させないのは bucket lock。

## Result

- verdict: **PASS**（reviewer-0153、blocking 0）
- reviewer: reviewer-0153（この変更を書いていない別エージェント）
- HEAD: 85c3511（rebase 後。main に ff 統合）
- 受入: 6/6。`npm run check` exit 0（527 tests / 95 files、33.3s）
- 確認: object id は実 git の hash-object と一致（空 / hello / 非 UTF-8 / 1MB / commit / tree）。pack は実リポジトリの object から作り、空リポジトリで `git index-pack` → `cat-file` / `rev-list --objects` で commit→tree→blob を取得。境界 size 0〜70000 も一致。実 R2 binding の integration は skip していない。
- 非 blocking（低 8、follow-up）: docs の exports に ./objects を追記（本 commit で対応）/ unit の pack 検査が entry header を見ない（検出は integration）/ R2 型と ObjectBucket の型結びつきが無い（0157 で satisfies）/ head の存在だけの dedupe は同キー別内容を黙って通す / head→put の TOCTOU / 製品経路から未接続の明記 / 不完全 closure の restore 文言が強い / pack のメモリ上限が未記載。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: 第2波で now へ（0154 の checkpoint と 0169 の 256KB 超の本文を開ける）。BOARD は別セッションの編集が落ち着いてから lead が反映。
- 2026-11-17: テスト条件（C1–C14）とテスト設計（T1–T10）、Design を追加。`touches` に実装に必要なファイル（index / package exports / tsdown / integration / deploy 配線 / docs/durability.md）を追加。受入6を「versioning と object lock」から「object lock + key 設計」に修正した（R2 に bucket versioning が無いため。理由は Design と docs/durability.md §5）。
- 2026-11-17: 実装。`packages/workspace/src/objects.ts` に object id（crypto.subtle）・git v2 pack・put / get / head / list・重複排除・checkpoint pack を置き、`@hns/workspace/objects` として公開。unit（11）と、`cf dev` の実 R2 binding で pack を `git index-pack` / `cat-file` / `rev-list` に通す integration（2）を追加。`OBJECTS` binding を `tools/deploy/cloudflare.config.ts` と `packages/server/src/edge/env.ts` に配線。`docs/durability.md` §5 に key の形と bucket lock の手順を追加。`npm run check` exit 0（lint / fmt / typecheck / 527 tests / build / deploy dry-run / knip）。独立レビューは未実施。
- 2026-11-17: reviewer-0153 PASS（blocking 0）。main へ ff 統合（85c3511）。低 8 を Result に記録（1 は本 commit で docs を追記）。

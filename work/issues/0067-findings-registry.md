# 0067: レビュー findings の記録場所

status: done
depends-on: -
touches: work/findings

## Goal

レビューで出た指摘を、発生日・場所・内容・メタ情報つきで継続的に記録する場所を作る。頻出・再発を数えられる形にする。

## Acceptance criteria

- [x] `work/findings/` に schema と追記ルールを置く
- [x] `findings.jsonl` を追記専用の1行1件にする
- [x] 0045 と 0047 の review を初期データとして入れる
- [x] `mechanism`（type / codec / lint / test / doc）と `recurrence_of` を持たせる
- [x] 0052〜0065 は issue を正とし、重複させない方針を書く

## やらないこと

- 集計ツール・ダッシュボード（`jq` の例だけ）。
- issue tracker の置き換え。

## Log

- 2026-11-07: `work/findings/README.md` と `findings.jsonl` を作成。0045 の9件、0047 の11件を初期データにした。

## Result

- 場所: [findings.jsonl](findings.jsonl)。schema と追記ルールは [README.md](README.md)。
- 0045 / 0047 の20件を初期データとして記録。
- 0052〜0065 は issue を正とし、重複して書かない。
- 独立 review の対象外（docs/process のみ。挙動・契約・安全の変更なし）。

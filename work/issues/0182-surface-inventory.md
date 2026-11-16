# 0182: GraphQL 以外の面を、どの issue がどの形で足すかを決める

status: open
priority: plan
design: pending
depends-on: 0179
touches: docs/, work/issues/, packages/web/, packages/server/

## Goal

0188 で REST の宣言（49 本の ROUTES と schema、web の typed client）を全部消した。D059 により、REST 面は
「それを実装する issue が schema・認証・handler を同じ変更で足す」。ここでは、GraphQL に載らない面を
**どの issue が・どこに・どんな認証で**足すかと、TanStack Query を残す範囲を決める。

## Acceptance criteria

- [ ] 面ごとに「実装する issue / 置き場（server 内のパス）/ 認証 / 理由」を1行ずつ決める
      （passkey・secrets・files・hooks・運用（health / metrics / usage / events）・me・machine）
- [ ] chat の送信面を決める（WS のメッセージか REST POST か）。0159 / 0176 と整合させる
- [ ] TanStack Query を残す範囲を決める（画面状態と、GraphQL 以外の面）
- [ ] 0036 / 0100 / 0188 と docs の記述を更新する
- [ ] `npm run check` が通る

## Notes

- 0188 で 49 ルートと typed client は削除済み。**分類表は作らない**（分類する対象がもう無い）。
- D055 の「22 本は REST に残す」は D059 で撤回した。面は実装と同時に宣言する。
- 実装そのものは、各行が指す issue が持つ。

## やらないこと

- この issue での実装（順序・置き場・認証を決めるだけ）。

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: 0188 で REST 契約を撤去したため、「49 の分類」から「面ごとの再導入」に書き換え。

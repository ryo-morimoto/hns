# 0271n: 会話の rename / archive / delete の面

status: open
priority: next
design: pending
design-ref: 0105 の Result / 0029（PoC の PATCH・DELETE）
depends-on: 0119
touches: packages/server/src/conversations/, packages/server/src/edge/handler.ts, packages/server/src/graphql/, packages/store/src/repositories/, packages/web/src/screens/conversation/

## Intent

0105（Conversation 画面）は受入に「rename / archive / delete」を持っていたが、**0029 は done と書かれているのに、その面（PATCH / DELETE）は PoC にしか無く、このパッケージには入っていない**。画面は archived の表示だけを実装し、操作は無い。人の操作から会話を管理できないままになっている。

## Acceptance

- [ ] rename / archive / delete の**面を 1 つに決める**（REST か GraphQL。D059 の「面を実装する issue が同時に認証を宣言する」に従う）
- [ ] archive は **Undo** が効く（0105 の受入どおり）
- [ ] delete は**確認**があり、**論理削除**（0029 の形）で 404 になる
- [ ] 画面から呼べる（0105 の会話ヘッダー）
- [ ] 実経路で 1 本（実 edge → 実 D1 → object の metadata → index drain）

## Log

- 2026-11-18: 0105 のレビューで「0029 の面が存在しない」ことが判明。**0029 の Result は PoC の記述で、製品の面ではない**（done の意味が実装より広い）。設計は next で決める。

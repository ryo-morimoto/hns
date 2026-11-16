# 0114: Web visual / interaction review（状態行列のスクリーンショット）

status: open
priority: plan
design: pending
depends-on: 0113
touches: packages/web/test/visual, work/issues/0036-web-ui.md

## Goal

画面を「正常系の1枚」で終わらせない。empty / loading / error / offline / running / needs / completed /
aborted を撮り、INTENT.md と GOLDEN.md の判断に照らしてレビューする。

## Acceptance criteria

- [ ] 各画面（workspace / conversation / editor / settings / auth / project-task / workflow / automation）の状態スクリーンショット
- [ ] 390px と 1440px の両方。dark も主要画面だけ
- [ ] INTENT の I1–I8 と、GOLDEN の7項目（interruptibility / continuity / precision / latency / frequency / density / keyboard）で所見
- [ ] blocking は画面 issue に戻す。改善は issue 化し、0036 に Result を残す
- [ ] 画像はリポジトリに重いバイナリを置かず、保存先と再生成コマンドを書く

## Notes

- 「Canary flow」の手順は参考。Intent に照らして不要な演出は落とす
- スクリーンショットは Playwright で再生成できるようにする（0043 のツール決定と整合）
- レビュー結果は 0036 の Result に、reviewer / HEAD / blocking を記録する

## やらないこと

- 新機能の追加
- E2E の全面整備（0043）

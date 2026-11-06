# 0068: codec review の low 残件

status: open
depends-on: 0066
touches: packages/core, packages/store, packages/workspace, docs/workspace.md

## Goal

0066 の独立 review で PASS したうえで残った low 5件を片付ける。

## Acceptance criteria

- [ ] 不正な operationId の直接呼び出しを audit に残すか、docs/workspace.md の「denied は audit に残る」から除外する
- [ ] codec の owner テストの主張を狭める（literal の再定義だけを見る）か、schema/constructor の export 箇所も検査する
- [ ] agent の operationId sanitizer を codecs.ts に移し、alphabet / 長さの規則を1箇所にする
- [ ] 拒否テストで `../../escape` を通し、journal / temp が作られないことも確認する
- [ ] `createFiring.at` の非 ISO バイパスを store のテストで拒否する

## Notes

- 0066 の Result に reviewer / HEAD / blocking なしを記録済み。
- どれもこの変更で生まれた低リスクの残件で、契約・データ・安全の blocking ではない。

## やらないこと

- すべての DTO の timestamp を brand にすること。

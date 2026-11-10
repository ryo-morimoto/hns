# 0127: Project と Workspace root の関連

status: open
priority: plan
depends-on: 0033, 0047, 0145, 0146
touches: packages/core/src/types.ts, packages/core/src/schemas.ts, packages/core/src/http.ts, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

Project を単なるラベルではなく、1つの workspace root と agent の cwd に結びつける。
UI のプロジェクト切替が、実際に別のファイル空間を開くようにする。

## Acceptance criteria

- [ ] Project に workspace root / agent cwd を持たせる（core / store / API）
- [ ] root は許可された親配下に正規化。symlink / .. / 別ユーザーの path を拒否
- [ ] 既存 project は現行 root を指す migration。不明な root は fail closed
- [ ] 会話作成・Agent 起動・file API が project の root を使う
- [ ] project 切替で workspace / conversation / editor の対象が変わる
- [ ] テスト: 正規化、拒否、migration、別 project の分離

## Notes

- 0109 の Project / Task 画面と 0104 のプロジェクト切替が使う
- マルチマシン（0044）はまだ。root はローカルパス
- 危険な path を UI から自由入力させない。許可 root の選択肢から選ぶ

## やらないこと

- リモートマシンの root
- Git リポジトリの自動作成

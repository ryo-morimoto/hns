# 0125: File tree と file search API

status: open
priority: plan
depends-on: 0033, 0145, 0146
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/workspace/src, packages/server/src, packages/server/test

## Goal

Editor が大きなワークスペースでもファイルを探せるようにする。
平らな一覧ではなく、rooted な tree と検索を返す。

## Acceptance criteria

- [ ] GET /api/files/tree?path=&depth= が directory / file を返す。depth は上限付き
- [ ] GET /api/files/search?q=&limit= が path の部分一致を返す。hidden / excluded を除外
- [ ] path は workspace root 配下に正規化。symlink は追わない。.. は拒否
- [ ] 結果は path 順、limit は 1–200、next_cursor
- [ ] 読めないディレクトリは error にせず、その階層だけ欠落として返す（理由付き）
- [ ] テスト: 境界、symlink、hidden、深い階層、大量ファイル

## Notes

- 0106 の Editor が使う。既存の GET /api/files は互換のため残す
- 検索は path のみ。本文 grep は別 issue（必要になったら）
- パスの正規化は workspace の既存 helper を使う。再実装しない

## やらないこと

- ファイル本文の検索 / 置換
- Git の status / diff

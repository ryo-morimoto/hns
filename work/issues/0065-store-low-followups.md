# 0065: store の low 残件（clock・ISO・comment）

status: open
priority: hold
depends-on: 0047
touches: packages/store, packages/core/src/http.ts, docs

## Goal

0047 の独立 review で PASS したうえで残った非 blocking の3件を片付ける。

## Acceptance criteria

- [ ] default clock（`options.now` 未指定）は open 時の tick をキャッシュしない。注入 clock のときだけ初回値を保持する
- [ ] ISO timestamp の schema を1箇所に寄せる（`schemas.ts` と `db.ts` の二重定義をなくす）
- [ ] core の `Automation.last_fired_at` のコメントを full ISO に合わせる
- [ ] それぞれ回帰テストを足す（clock は open 後の最初の write の時刻、ISO は不正値の拒否）

## Notes

- 0047 の review で low / non-blocking と判定されたもの。
- 0035 の scheduler は `last_fired_at` に full ISO を渡す（0035 の Notes に記載済み）。

## やらないこと

- identity（0048）。
- 挙動を変えない整形だけの変更。

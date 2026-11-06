# 0058: auditLog を不変にする

status: open
depends-on: 0045
touches: packages/workspace

## Goal

`Workspace.auditLog` は内部の配列をそのまま返している。TS の `readonly` は実行時には効かないので、
呼び出し側が push して監査ログを書き換えられる。返す値を凍結するか写しにする。

## Acceptance criteria

- [ ] `auditLog` の戻り値を不変にする（`Object.freeze` か `[...]` の写し）
- [ ] 呼び出し側の変更が次の `auditLog` に現れないことをテストで固定する
- [ ] 同じ扱いが要る他の getter（`mode` を除く）が無いか確認する

## Notes

- 監査ログは journal から読み直されるので、渡した配列を書き換えても永続状態は変わらない。
  問題は「呼び出し側が見る値」と「保存された値」がずれること。

## Log

- 2026-11-07: 作成（コードレビューで可変の配列を返しているのを見つけた）。

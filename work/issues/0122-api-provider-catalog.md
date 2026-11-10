# 0122: Provider / model catalog と鍵の検証

status: open
priority: plan
depends-on: 0034, 0145, 0146
touches: packages/core/src/graphql, packages/agent/src/providers, packages/agent/test, packages/server/src, packages/server/test

## Goal

設定画面が、利用可能な provider / model と能力を一覧し、鍵を保存する前に検証できるようにする。
鍵の値は返さず、ログにも出さない。

## Acceptance criteria

- [ ] GET /api/providers が provider / models / capabilities（tools / vision / context / cost）を返す
- [ ] POST /api/providers/:id/validate が、保存済みまたは一時的な鍵で疎通を確認する
- [ ] 検証結果は ok / invalid_key / unreachable / unsupported。鍵の断片も返さない
- [ ] 鍵は 0069 の secret に保存し、catalog は鍵を読まない
- [ ] timeout と rate limit を設け、外部への連続リクエストを防ぐ
- [ ] テスト: fake provider で成功/失敗/タイムアウト、ログに鍵が出ない

## Notes

- agent の providers が能力の正本。server は集約するだけ
- model の能力差（tool 非対応など）を UI が先回りして仮定しない
- 0107 の Settings が使う

## やらないこと

- OAuth（0128）
- モデルの自動ダウンロード

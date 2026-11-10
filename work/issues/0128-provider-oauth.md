# 0128: Provider の OAuth / token refresh

status: open
priority: plan
depends-on: 0069, 0107, 0122
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/agent/src/providers, packages/store/src, packages/server/src, packages/server/test, packages/web/src/screens/settings

## Goal

API key だけでなく、OAuth が必要な provider を設定できるようにする。
token は暗号化して保存し、期限前に refresh する。

## Acceptance criteria

- [ ] provider ごとの auth 方式（api_key / oauth）を catalog に持つ
- [ ] OAuth の開始・callback・state / PKCE 検証。redirect URI は固定
- [ ] access / refresh token は 0069 の secret に保存。ログ・URL・DOM に出さない
- [ ] refresh 失敗は「再認証が必要」として UI に返し、勝手に再試行しない
- [ ] revoke / 切断。既存の会話は失敗として表面化する
- [ ] テスト: state 不一致、期限切れ、refresh 成功/失敗、秘密の非表示

## Notes

- 0122 の catalog と 0107 の Settings が入口
- 外部通信は fake provider でテストし、実 OAuth は手動確認
- token を localStorage に置かない。サーバー側の暗号化保存だけ

## やらないこと

- マルチアカウント
- 組織の SSO

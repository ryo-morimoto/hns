# 0165: 安全の再評価（XSS→exec・サプライチェーン・egress）

status: open
priority: next
design: agreed
design-ref: D096
depends-on: 0147
touches: docs/safety.md, packages/machine/test/security/, packages/server/src/ws.ts, packages/server/src/edge/, packages/server/test/, packages/web/test/

## Goal

Cloudflare から手元の exec に届く構成になったぶん、攻撃面を洗い直す。

## Acceptance criteria

- [ ] UI の XSS が exec に届く経路を塞ぐ（CSP、エスケープ、権限の分離）
- [ ] Worker の依存を最小にし、デプロイ権限を exec 権限として扱う
- [ ] DO から出る通信先を絞る（provider gateway とトンネルのみ）
- [ ] sandbox の fail closed を再確認（bwrap 無しは exec を出さない）
- [ ] エージェントの攻撃面（署名・nonce・パス・出力上限）のレビュー
- [ ] 事故時の封じ込め（鍵失効・machine 失効・Worker 停止）

## Notes

- 0052（hide 未配線）が閉じていないと、手元の鍵はエージェントから読める。

## Design（D096 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D096）。

### 前提

- 0147（署名・パス・上限）と 0194（bwrap / hide / env 純度）が入る。0127（project = 信頼境界）、D079（A Native 認証）、0159（WS）。
- この issue は**新しい機能ではなく、攻撃面の棚卸しと封じ込めの確認**。成果は docs/safety.md の脅威表と、境界ごとのテスト。

### 決定 1: 信頼境界

| 境界 | 信頼しないもの | 守るもの |
| --- | --- | --- |
| browser ↔ edge | 画面の DOM / 入力 / 拡張 | session cookie（HttpOnly / SameSite） |
| edge ↔ DO | 入力の id / projectId / 本文 | 認可、owner、path、上限 |
| DO ↔ gateway | モデルの出力 / provider | provider 鍵（gateway の secret）、予算 |
| machine ↔ sandbox | agent のコマンド / 生成コード | ホストの鍵、兄弟 project、egress |
| 運用者 ↔ CF | deploy token / 権限 | exec と同等の権限として扱う |

### 決定 2: XSS → exec の経路を塞ぐ

- 本文・ファイル名・モデル出力は**テキストとして描画**。`dangerouslySetInnerHTML` を使わない。markdown を足すときは sanitize（許可タグのみ）。
- CSP（0160）: `script-src 'self'`。inline script なし。
- session cookie は `HttpOnly` + `SameSite=Lax` + `Secure`。`session.ts` は署名 / 検証だけで、属性を付けるのは login（0108）。GraphQL は JSON POST（cross-origin の単純リクエストにしない）。
- **WS の upgrade で `Origin` を検証**する（他 origin のページから socket を開かせない）。**現行の `packages/server/src/ws.ts` に Origin 検証は無い**（2026-11-17 に確認）。0159 の done 後の追補として、この issue で upgrade 時に許可 origin と比較する。
- mutation は session と owner を境界で検証（UI の状態を信じない）。

### 決定 3: サプライチェーンとデプロイ権限

- Worker / DO の依存は exact pin、lock をコミット。runtime に `npm install` しない。
- **deploy token は exec 権限として扱う**。CF API token は最小スコープ（Worker / D1 / R2 / secrets）に分け、人は使い回さない。
- provider 鍵は gateway の secret だけ（D085）。control-plane 鍵 / device 鍵 / cloudflared token を repo・machine env・DO に置かない。

### 決定 4: DO から出る通信先

- DO / edge の fetch は **gateway の service binding と machine の tunnel hostname だけ**。ユーザー入力の URL を fetch しない。
- 送信先はコードの定数 / binding で固定し、レビューで確認する（実行時の URL allowlist を装わない）。

### 決定 5: sandbox の fail closed

- bwrap が無い / probe 失敗 → exec を出さない（0194）。
- hide は固定リスト、`.git` は ro-bind、env は allowlist、egress の `deny` は `--unshare-net`。
- 残余リスク: prompt injection → agent が sandbox 内で exec → egress。`deny` の project では外に出られないが、`inherit` では出られる。docs/safety.md に明記する。

### 決定 6: 事故時の封じ込め

- machine の失効（D087）: `revoked` で以後の署名を拒否。
- control-plane 鍵のローテーション（公開鍵を併記 → 配布 → 旧鍵削除）。
- session の全失効、automation の停止、Worker の停止。
- 監査: 誰が・いつ・どの machine を失効したかをイベントに残す（本文・鍵は出さない）。

### 決定（D096）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | CSRF の守り | **決定（user）**: SameSite=Lax + JSON POST + WS Origin（現行は未実装）。CSRF token は足さない | D079 / 0160 / 0159 | 2026-11-17 |
| U-02 | DO の egress | **決定（user）**: コードの定数 / binding で固定（runtime allowlist ではない） | 0145 / 0151 | 2026-11-17 |
| U-03 | 事故演習の範囲 | **決定（user）**: 失効・鍵ローテーション・停止の手順を docs。テストは執行・ローテーション・失効・401 まで | 0165 | 2026-11-17 |
| U-04 | 依存監査の頻度 | **決定（user）**: ゲートで lock / pin。CVE の自動監視は別 issue | 0041 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `<img onerror>` を含むファイル名 / 本文 → 画面 → 実行されずテキストで出る | 高 | 受入1 |
| C2 | 他 origin の POST /graphql → cookie が送られず 401。WS upgrade の Origin 不一致 → 拒否 | 高 | 受入1 |
| C3 | 任意 URL を fetch する経路が無い（コード / テスト） | 高 | 受入3 |
| C4 | bwrap 無し → exec 拒否。hide / `.git` / env のテスト（0194） | 高 | 受入4 |
| C5 | machine を revoked → 以後の署名が 401。鍵ローテーションで旧鍵が 401。失効・ローテーションの執行をテストする | 高 | 受入6 / D096 |
| C6 | machine の env / DO の env に鍵が無い | 高 | 受入2・4 |
| C7 | docs/safety.md の脅威表が更新され、残余リスク（prompt injection → exec → egress）が明記 | 中 | 受入5 |
| C8 | `npm run check` | 高 | — |

## Log

- 2026-11-17: D096 で合意。U-01〜U-04 を決定し、`design: agreed` にした。

## やらないこと

- マルチテナントの分離。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。

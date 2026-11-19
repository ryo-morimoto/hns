# 0152: 実プロバイダ（faux → 実・ストリーミング・usage）

status: open
priority: next
design: agreed
design-ref: D088
depends-on: 0146, 0151, 0159
touches: packages/agent/src/providers/, packages/agent/test/, packages/server/src/do/, packages/server/src/edge/, packages/server/test/, tools/deploy/

## Goal

faux の台本を実プロバイダに置き換え、DO からのストリーミングと usage の記録を通す。

## Acceptance criteria

- [ ] Ollama Cloud と OpenCode Go の 2 つで会話が通る（0012 / 0013 の再確認）
- [ ] token の delta がブラウザまで WS で流れる（0159）
- [ ] usage をターン単位で記録し、gateway の上限と突き合わせる
- [ ] 失敗（429 / 5xx / 中断）の扱いを決めてテスト
- [ ] 長い応答で DO の CPU / メモリが上限に当たらないことを測る（0163）

## Notes

- PoC は faux。実測の RTT はプロバイダの時間を含まない。
- ストリーミングのスループットは未計測（RESULTS.md の未計測項目）。

## Design（D088 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D088）。

### 前提

- 0146 の `openSession` は faux で動く。0151 の gateway は `POST /v1/<provider>/chat/completions` の固定ルートを持ち、鍵は gateway の secret、予算は D1。
- 0159 の WS はサーバ→クライアントの snapshot / append / delta / error を持つ。DO は harness の live を流す。
- harness は DO の中で動き、provider 鍵を持たない（0143 / 0151）。

### 決定 1: gateway を service binding で呼ぶ

- pi-ai の provider は `baseUrl = https://gateway.internal/v1/<provider>` とし、`fetch` を service binding の `fetch` に差し替える。
- 鍵は harness から送らない。provider の `apiKey` は placeholder（gateway が上流の Authorization を自分の secret で置き換える）。
- モデルは `HNS_MODEL` / catalog（0122）から選ぶ。provider ごとに route が決まる。
- 主 Worker と Session DO の env に `GATEWAY` binding を足す（tools/deploy）。

### 決定 2: ストリーミングは既存の live に載せる

- pi-ai の streaming を harness の live doc に書かせ、0159 の WS が delta を流す（新しい中継を作らない）。
- delta の間引きは 0159 の 100ms / 64KB のまま。長い応答でも DO のメモリに全文を溜めない。
- abort は harness の abort → live に error / aborted を流す。

### 決定 3: usage は DO に記録し、D1 へは flush

- ターン終了時に harness の usage（トークン / コスト）を DO の usage に残す（0146 の `pi.usage`）。
- 対話の send は、RPC の応答に usage を載せ、Worker が `usage_log`（D1）へ書く。背景の turn は DO の outbox に積み、**DO の狭い usage writer** で D1 へ flush する（0145 の例外。Worker の次の要求を待たない）。
- gateway の予算（D1）と usage をターン単位で突き合わせる。差が大きいときは 0163 の metric に出す。

### 決定 4: 失敗と中断

- gateway / provider の 429 → `rate_limited`、5xx / network / timeout → `unavailable`、abort → `aborted`。
- 再試行は harness の retry policy に任せ、gateway の budget が戻ることを確認する（0151）。二重課金しない。
- WS には typed error を流し、UI は「待ち / 失敗 / 中断」を区別する。

### 決定 5: 計測

- 長い応答（例: 32k tokens）で DO の CPU / メモリが上限に当たらないことを 0163 の計測で確認する。
- delta のフレーム数とスループットを実測し、0159 の間引きを調整する。

### 決定（D088）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | gateway の呼び方 | **決定（user）**: service binding + placeholder key | 0151 / deploy | 2026-11-17 |
| U-02 | usage の書き込み | **決定（user）**: DO に記録。対話は Worker、背景は DO の狭い writer で D1 へ flush | 0049 / 0163 | 2026-11-17 |
| U-03 | streaming の経路 | **決定（user）**: harness の live → 0159 の WS（新規中継なし） | 0159 | 2026-11-17 |
| U-04 | 失敗の写像と再試行 | **決定（user）**: 429 / 5xx / abort を typed。再試行は harness | 0151 / 0146 | 2026-11-17 |
| U-05 | モデル選択 | **決定（user）**: `HNS_MODEL` + 0122 の catalog（v1 は既存の provider 定義） | 0122 / 0036 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | fake gateway が stream → 会話が通り、delta が WS に流れる | 高 | 受入1・2 |
| C2 | Ollama Cloud / OpenCode Go の 2 provider → 同じ経路で通る | 高 | 受入1 |
| C3 | usage → ターン単位で記録され、gateway の予算と突き合う | 高 | 受入3 |
| C4 | 429 / 5xx / timeout → typed error。再試行で二重課金しない | 高 | 受入4 |
| C5 | abort → stream が止まり、aborted が WS に出る | 高 | 受入4 |
| C6 | 長い応答 → DO のメモリ / CPU が上限内。delta のフレーム数が想定内 | 中 | 受入5 |
| C7 | DO / harness の env に provider 鍵が無い（D143） | 高 | 受入1 |
| C8 | `npm run check` | 高 | — |

## Log

- 2026-11-17: D088 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

## やらないこと

- Google 系（権限待ち）。
- モデルの自動選択。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions/D047.md) の採用を受けて）。

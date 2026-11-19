# 0143: 秘密の配置（gateway・git はマシン・DEK）

status: done
priority: now
depends-on: 0140
touches: docs/auth.md, docs/automation.md, work/issues/0147-machine-agent.md

## Goal

どの秘密をどこに置くかを決め、「エージェントループのコードと同じ信頼領域に鍵を置かない」を原則にする。

## Acceptance criteria

- [x] 表: provider 鍵 / git・gh の資格情報 / webhook token / DEK / マシンのデバイス鍵 の置き場所
- [x] provider 鍵は gateway Worker のみが持ち、harness / machine / Session DO には置かないと明記
- [x] provider 側の支出上限と、gateway の緊急停止を要件に入れる
- [x] DEK は包んだまま DO、平文は unlocked 中のブラウザとサーバセッションのメモリだけ（D019 / D020）
- [x] sandbox の hide（0052）を MVP の前提条件に格上げ
- [x] 漏洩時の封じ込め手順（キー失効 → ローテーション）を1ページで書く

## テスト条件

- C1: docs-only。置き場所の表・gateway の鍵分離・DEK・hide・封じ込めが、D019 / D020 / D047 / D059 と矛盾しない。
- C2: 実装の受入は 0151（gateway の鍵分離・予算・停止。harness 側の env テストを含む）と
  0147（machine・デバイス鍵・cloudflared・hide。machine 側の env テストを含む）が持つ。
  webhook token の暗号化・再表示は 0038 / 0112 / 0131 が持つ。

## テスト設計

- T1: この issue では文書を review で確認する。コードのテストは 0151 / 0147、webhook は 0038 / 0112 / 0131 で書く。

## Notes

- 手元に鍵を置く案は、この製品では安全側にならない。エージェントが bash を実行するマシンであり、0052 が未配線のあいだは特にそう。
- git はマシンで動くので、資格情報を Cloudflare に渡さない。

## やらないこと

- gateway の実装（0151）。
- passkey の実装（0158）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions/D047.md) の採用を受けて）。
- 2026-11-10: [docs/auth.md](../../docs/auth.md) に「秘密の配置（0143）」を追加。表・gateway・git の例外・DEK・
  sandbox hide・封じ込め手順。PoC の service/provider は履歴と明記した。
- 2026-11-11: reviewer-0143 が **FAIL**（blocking 5）。provider 鍵 / DEK の置き場所、webhook token、0147 の鍵と
  hide の AC、封じ込めの順序と DEK 再暗号化。修正: provider 鍵はマシンから外す、DEK の平文はブラウザと
  サーバセッションのメモリ、webhook は service 鍵で暗号化、0147 の AC を更新、封じ込めに全秘密の停止と
  全 user 秘密の再暗号化を追加。再 review する。
- 2026-11-11: reviewer-0143 が再度 **FAIL**（blocking 3）。0143 の受入条件の旧文言、provider 鍵の machine 側テストの
  担当、service 鍵 / cloudflared の rotate・失効の閉包。修正: 受入条件をブラウザ + サーバセッションに、0147 に
  machine の env テストを追加、封じ込めに service 鍵 / cloudflared を追加。再 review する。
- 2026-11-11: reviewer-0143 が **PASS**（blocking 0）。残る低は Result に記録した。

## Result

- verdict: **PASS**（blocking 0。初回 FAIL 5 → 修正 → FAIL 3 → 修正 → PASS）
- reviewer: reviewer-0143
- HEAD: 4073bc0
- blocking: なし
- 受入: 6/6。docs-only のため `npm run check` は対象パッケージ無し（文書の突き合わせで確認）。
- non-blocking（残し。実装・後続 issue で掃除）:
  - 低 / `docs/auth.md:80`, `0147:19` / `git fetch` は `.git` に書くため、「agent は fetch を使える」と
    「`.git` 書き込み拒否」が両立しない。fetch を製品側（sandbox 外）にするか、拒否を agent の直接書き込みに限定する。
  - 低 / `docs/auth.md:52` / service 鍵の「使う主体」に webhook token の暗号化・復号を足す。
  - 低 / `docs/auth.md:42`, `0143:24-26` / webhook token の実装先 0038 / 0112 / 0131 の AC に項目が無い。
    どれかの AC に一行足すか、新規 issue にする。
  - 低 / `docs/auth.md:60`, `0151:16` / harness が provider の URL も持たないことのテストが 0151 に無い。
    URL 不在テストを足すか、主張を鍵に限定する。
  - 低 / `0143:14` / 表の対象に service 鍵・cloudflared token を足す（現在は5種の列挙）。
  - 低 / `docs/auth.md:123-124` / webhook token は TTL ではなく rotate / archive 時。「定期なし」と書く。
  - 低 / `docs/auth.md:93` / `join` / `homedir` の import 前提を実装時に補足する。
- 未確認: 0151 / 0147 は未実装。webhook の service 鍵暗号化は実装未着手。identity / user_keys の DO / D1 の
  置き場は未決。git credential helper の sandbox 到達経路は 0147 で決める。

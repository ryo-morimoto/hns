# 0147: マシンエージェント（cloudflared・署名）

status: open
priority: now
design: agreed
design-ref: D047, D053
depends-on: 0145
touches: packages/machine/, docs/packages.md, oxlint.config.ts, vitest.config.ts, package-lock.json, work/issues/0147-machine-agent.md

## Goal

マシン側で動く常駐エージェントを作る。外向き接続だけで Cloudflare から届き、署名を検証し、ROOT の外に出さない。
sandbox・hide・env 純度は環境依存なので 0194 に分け、この issue は fixture で検証できる範囲に絞る。

## Acceptance criteria

- [ ] `cloudflared` の後ろで `127.0.0.1` に待ち受ける（inbound ポートを開けない）
- [ ] リクエスト署名（Ed25519。秘密鍵はマシン（0600）、公開鍵は D1 の Machine レコード（D049））と時刻窓・nonce で再生を拒否
- [ ] パスは ROOT 内に正規化し、symlink の親で外に出ない。失敗は型付きの拒否
- [ ] 同時実行数・出力サイズ・時間の上限
- [ ] 二重接続のうち古い方を seq で弾く
- [ ] 署名検証と ROOT 脱出のテスト（実 HTTP、モックなし）
- [ ] `npm run check` が通り、独立レビューが PASS する

## テスト条件

| ID  | 条件（Given → When → Then）                                                                                      | リスク | 出所       |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| C1  | 正しい鍵で署名した health → 200、ROOT と pid を返す                                                              | 高     | AC1, AC2   |
| C2  | 署名が無い / 別の鍵 / body だけ差し替え → 401 unauthorized。op は実行されない                                    | 高     | AC2        |
| C3  | timestamp が窓（±60s）の外（過去・未来）→ 401 stale_request                                                      | 高     | AC2        |
| C4  | 同じ nonce と同じ署名の 2 回目 → 409 replayed。1 回目の結果は変わらない                                          | 高     | AC2        |
| C5  | 登録に無い machine id / 鍵 → 401 unauthorized                                                                    | 中     | AC2, 0148  |
| C6  | 古い接続の seq → 409 stale_connection。より大きい seq の接続は通り、以後古い接続は通らない。同じ seq の別接続も拒否 | 高     | AC5        |
| C7  | `..` を含むパス → 400 path_denied。`/` 始まりは ROOT 相対に正規化され、ROOT の外は指さない                     | 高     | AC3        |
| C8  | 親が ROOT 外を指す symlink（`link/secret.txt`）→ 400 path_denied。内容は応答に出ない                            | 高     | AC3        |
| C9  | 最終要素が ROOT 外を指す symlink → 403。内容は応答に出ない                                                        | 中     | AC3        |
| C10 | ROOT 内の通常ファイルの read / stat / list → 内容・サイズ・sha256 を返す                                          | 中     | AC3        |
| C11 | 同時実行数が上限に達した状態でもう 1 本 → 429 busy。空いたら次の要求は通る                                       | 中     | AC4        |
| C12 | body が上限を超える → 413 too_large                                                                              | 中     | AC4        |
| C13 | 応答（read/list）が上限を超える → 413 too_large。内容は返さない                                                   | 中     | AC4        |
| C14 | body を送り切らない要求 → 時間上限で 408 deadline_exceeded。待ち続けない                                          | 中     | AC4        |
| C15 | 待受は 127.0.0.1 のみ。ループバック以外の interface からは接続できない                                            | 高     | AC1        |
| C16 | デバイス鍵: 0600 は読め、0644 は拒否、symlink は拒否                                                              | 高     | AC2        |
| C17 | 未対応 op / JSON でない body → 400 invalid_request                                                                | 中     | AC3        |
| C18 | POST 以外 / `/rpc` 以外 → 405 / 404                                                                               | 低     | AC1        |

テストしない条件:

- bwrap・hide・env 純度・実機の cloudflared 経由（理由: 環境依存。0194 が実機で確認する）。
- D1 への登録・失効（理由: 0148。ここは `MachineKeyRegistry` の interface と fixture で固定する）。
- exec と書き込み（理由: sandbox が無い環境で exec を出さない（fail closed）。0194 で足す）。
- Windows / macOS の sandbox（理由: 0006 の範囲外）。

## テスト設計

| ID  | 条件 | 技法             | 層          | テスト                                                                              |
| --- | ---- | ---------------- | ----------- | ----------------------------------------------------------------------------------- |
| T1  | C1   | ユースケース     | integration | `test/integration/agent.test.ts` "a signed health call is answered"                |
| T2  | C2   | 故障注入         | integration | 同 "an unsigned request, a foreign key, and a swapped body are refused"              |
| T3  | C3   | 境界値分析       | unit        | `src/signature.test.ts` "the window accepts the boundary and refuses beyond it"     |
| T4  | C3   | 故障注入         | integration | `test/integration/agent.test.ts` "a stale timestamp is refused"                     |
| T5  | C4   | 状態遷移         | integration | 同 "a replayed nonce is refused"                                                     |
| T6  | C4   | 境界値分析       | unit        | `src/signature.test.ts` "a nonce is remembered until its window closes"             |
| T7  | C5   | 同値分割         | integration | 同 "an unregistered machine is refused"                                              |
| T8  | C6   | 状態遷移         | unit        | `src/connection.test.ts` "a newer connection takes over and the older one is stale"  |
| T9  | C6   | 故障注入         | integration | 同 "the older connection is refused after a newer one connects"                       |
| T10 | C7   | 同値分割         | unit        | `src/containment.test.ts` "normalization names stay inside the root"                 |
| T11 | C7   | 故障注入         | integration | 同 "a parent segment and an absolute path never leave the root"                       |
| T12 | C8   | 故障注入         | integration | 同 "a symbolic link as a parent does not escape the root"                             |
| T13 | C9   | 故障注入         | integration | 同 "a symbolic link as the final component is not followed"                           |
| T14 | C10  | ユースケース     | integration | 同 "reading and listing inside the root returns the bytes and their version"          |
| T15 | C11  | 競合テスト       | integration | 同 "a request beyond the concurrency limit is refused"                                |
| T16 | C12  | 境界値分析       | integration | 同 "a body over the request limit is refused"                                         |
| T17 | C13  | 境界値分析       | integration | 同 "a response over the output limit is refused"                                      |
| T18 | C14  | 故障注入         | integration | 同 "a request that never finishes its body meets the deadline"                        |
| T19 | C15  | 契約テスト       | integration | 同 "the agent listens on loopback only"                                               |
| T20 | C16  | 同値分割         | unit        | `src/device-key.test.ts` "a key readable by group or other is refused"               |
| T21 | C17  | 同値分割         | unit        | `src/wire.test.ts` "an unknown operation or a non-JSON body is refused"              |
| T22 | C18  | 同値分割         | integration | 同 "a request that is not POST /rpc is not found"                                     |
| T23 | C11  | 状態遷移         | unit        | `src/limits.test.ts` "a slot is released once and never below zero"                  |

## Notes

- PoC: `work/poc/cf-harness/agent/server.mjs`（HMAC・ROOT 封じ込め・上限）。sandbox は無い。
- HMAC は共有秘密なので製品では Ed25519 にする。PoC の結論は「署名検証は 1 か所に集まる」。
- エージェントは配布物になる（nix / 単体バイナリ / npm）。配布は 0040 に含める。

## やらないこと

- 認証・machine の登録（0148）。
- sandbox（bwrap）・hide・env 純度・実機確認（0194）。
- Windows / macOS の sandbox（0006 の範囲外）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-11: 0143 の review を受けて、デバイス鍵を「秘密鍵はマシン / 公開鍵は D1」に直し、hide の読み取りと
  「隠した場所から鍵が読めない」実機テストを AC に追加した。
- 2026-11-11: 再レビューを受けて、machine の env / process に provider 鍵・provider URL が無いことのテストを AC に追加した。
- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L3。パッケージ追加に伴う `docs/packages.md`・`oxlint.config.ts`・`vitest.config.ts`・lock を touches に足した。lock owner。
- 2026-11-11: 0147 / 0146 の並行中に、環境依存の受入条件（bwrap・hide・env 純度・実機確認）を 0194 へ分割。
  0147 は署名・パス封じ込め・上限に絞り、fixture と実 HTTP で先に統合する。
- 2026-11-17: 実装。`## テスト条件`（C1–C18）と `## テスト設計`（T1–T23）を追加した。
  公開鍵は `MachineKeyRegistry`（0148 が D1 の Machine レコードから供給）の interface にして fixture で固定した。
  `x-hns-seq` は接続インスタンスの連番（要求ごとには変えない）。パスは `/` 始まりを ROOT 相対として正規化し、
  `..` を拒否、親を canonical 化、最終要素は `O_NOFOLLOW` で追わない。exec と書き込みは sandbox が無い環境では
  出さない（fail closed。0194 で足す）。
- 2026-11-17: 署名の向きを1か所に集めた。0147 が持つのは「受け取った要求を登録済み公開鍵で検証する」
  `RequestVerifier` で、秘密鍵（0600）がマシン・公開鍵が D1 という配置（D049）は変えない。Worker 側がどこで署名し、
  どの鍵を Machine レコードに載せるかは 0148 の registry と auth の面で確定する（この issue は interface と拒否だけを固定）。

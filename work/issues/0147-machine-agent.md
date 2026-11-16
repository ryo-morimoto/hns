# 0147: マシンエージェント（cloudflared・署名）

status: open
priority: now
design: agreed
design-ref: D047, D053
depends-on: 0145
touches: packages/machine/, docs/packages.md, oxlint.config.ts, vitest.config.ts, package.json, package-lock.json, AGENTS.md, work/issues/0147-machine-agent.md

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
| C9  | 最終要素が ROOT 外を指す symlink → read と list は 403 forbidden、stat は追わず kind: symlink を返す。内容は応答に出ない | 中     | AC3        |
| C10 | ROOT 内の通常ファイルの read / stat / list → 内容・サイズ・sha256 を返す                                          | 中     | AC3        |
| C11 | 同時実行数が上限に達した状態でもう 1 本 → 429 busy。空いたら次の要求は通る                                       | 中     | AC4        |
| C12 | body が上限を超える → 413 too_large                                                                              | 中     | AC4        |
| C13 | 応答（read/list）が上限を超える → 413 too_large。内容は返さない                                                   | 中     | AC4        |
| C14 | body を送り切らない要求 → 時間上限で 408 deadline_exceeded。待ち続けない                                          | 中     | AC4        |
| C15 | 待受アドレスは 127.0.0.1（bind を直接検証）。ループバック以外の interface からは接続できない。外部 IPv4 が無いホストは理由付きで skip | 高     | AC1        |
| C16 | デバイス鍵: 0600 は読め、0644 は拒否、symlink は拒否                                                              | 高     | AC2        |
| C17 | 未対応 op / JSON でない body → 400 invalid_request                                                                | 中     | AC3        |
| C18 | POST 以外 → 405 method_not_allowed、`/rpc` 以外 → 404 not_found                                                   | 低     | AC1        |
| C19 | FIFO への read → 400 invalid_request。thread pool を塞がず、続く通常の read は通る                                 | 高     | AC4        |

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
| T13 | C9   | 故障注入         | integration | 同 "a symbolic link as the final component is not followed" / "a list does not follow a symbolic link" |
| T14 | C10  | ユースケース     | integration | 同 "reading and listing inside the root returns the bytes and their version"          |
| T15 | C11  | 競合テスト       | integration | 同 "a request beyond the concurrency limit is refused"                                |
| T16 | C12  | 境界値分析       | integration | 同 "a body over the request limit is refused"                                         |
| T17 | C13  | 境界値分析       | integration | 同 "a response over the output limit is refused"                                      |
| T18 | C14  | 故障注入         | integration | 同 "a request that never finishes its body meets the deadline"                        |
| T19 | C15  | 契約テスト       | integration | 同 "the agent binds to loopback only" / "a non-loopback interface cannot reach the agent"（外部 IPv4 が無いホストは理由付き skip） |
| T20 | C16  | 同値分割         | unit        | `src/device-key.test.ts` "a key readable by group or other is refused"               |
| T21 | C17  | 同値分割         | unit        | `src/wire.test.ts` "an unknown operation or a non-JSON body is refused"              |
| T22 | C18  | 同値分割         | integration | 同 "a wrong method and a wrong route are refused distinctly"                           |
| T23 | C11  | 状態遷移         | unit        | `src/limits.test.ts` "a slot is released once and never below zero"                  |
| T24 | C19  | 故障注入         | integration | 同 "a FIFO is refused without blocking the pool"                                      |

## Notes

- PoC: `work/poc/cf-harness/agent/server.mjs`（HMAC・ROOT 封じ込め・上限）。sandbox は無い。
- HMAC は共有秘密なので製品では Ed25519 にする。PoC の結論は「署名検証は 1 か所に集まる」。
- エージェントは配布物になる（nix / 単体バイナリ / npm）。配布は 0040 に含める。

## 未確定

- U-02: 署名の向きが AC と実装で一致しない。
  - 現状の矛盾: AC は「秘密鍵はマシン（0600）、公開鍵は D1 の Machine レコード」としつつ、machine が要求を検証する形を求めている。
    秘密鍵がマシンにあるなら、Worker は machine の device key で署名できない（machine が検証する側に回れない）。
  - 案1: **control-plane 鍵を分ける**。Worker（harness）が自分の鍵で要求に署名し、machine はその公開鍵で検証する。
    device key（秘密はマシン / 公開は D1）は machine → Worker の署名にだけ使う。AC の parenthetical と D049 はこのまま生きる。
  - 案2: **向きを反転**。machine を呼び出し側にし、machine が device key で署名して Worker の endpoint を叩く（machine は検証しない）。
    AC の「署名を検証し」を落とす必要がある。
  - 案3: **0148 へ移す**。0147 は署名メッセージと検証器を interface として置くだけにし、どの鍵を Machine レコードに載せるか・
    どちらが署名するかを 0148 の登録・失効と一緒に決める。
  - いまの実装は案1の形（`RequestVerifier` が D1 の Machine レコードの公開鍵で受け取った要求を検証する interface と fixture）で、
    `MachineKeyRegistry` の指す先を差し替えれば案2・案3にも寄せられる。決定はユーザー待ち。

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
- 2026-11-17: reviewer の BLOCKED（blocking 2）を受けて修正。(1) `list` が最終要素の symlink を追っていた:
  `lstat` で最終要素の symlink を拒否し、ディレクトリでなければ 400、symlink なら 403。C9/T13 を read と list と
  stat の差に合わせた。(2) deadline が fs を止められず、FIFO 8 本で thread pool と slot が詰まった: read は
  `lstat` で非 regular（FIFO / device / socket）を開く前に 400 で拒否し、open に `O_NONBLOCK` を付けた。
  `runOperation` は `AbortSignal` を受け取り、read は abort で中断、他の段は前後で signal を確認し、
  操作が settle するまで slot を返さない（body read と verify は deadline と race）。C19/T24 を追加。
  ついでに C18/T22 を 405 / 404 に揃え、コードとテストから issue 番号を外し、limits の文言・AGENTS.md の
  planned・docs/packages.md の末尾改行・vitest.config.ts の整形だけの差分を直した。FIFO のテストは実 `mkfifo` を使うので、
  `package.json` の knip に `packages/machine` の `ignoreBinaries: ["mkfifo"]` を足した（touches に `package.json` を追加）。
  U-02（署名の向き）は未確定。
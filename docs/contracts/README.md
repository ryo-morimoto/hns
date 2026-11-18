# 契約（contract）

2026-11-18 / L6 M2。面ごとの契約を 1 面 1 ファイルで持つ。**契約はここが正本**で、コードの TSDoc は同じ内容を短く持ち、ここを指す。不変条件は [invariants.md](../invariants.md)。

| 面                                                       | 契約                                 | 実装の正本                                                                      | 主な不変条件          |
| -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- | --------------------- |
| 失敗（全 HTTP 面 + GraphQL）                             | [failures.md](failures.md)           | `server/src/failures/status.ts`                                                 | —                     |
| Workspace のファイル（版 / absent / checkpoint）         | [workspace.md](workspace.md)         | `@hns/workspace`、`do/workspace`、`@hns/machine`                                | INV-03 / 04 / 05      |
| Journal と索引（intent / outcome / watermark / dirtyAt） | [journal-index.md](journal-index.md) | `store/src/journal`、`do/journal`、`conversation-index`、`session-index`        | INV-04 / 09 / 10 / 11 |
| 会話の単体取得と state（0119、REST）                     | [conversation.md](conversation.md)   | `server/src/conversations`、`do/session-rpc` の `/rpc/state`、`edge/handler.ts` | INV-01                |
| 会話のライブ更新と chat の送信（0159 / D077、WS）        | [live-ws.md](live-ws.md)             | `core/src/stream.ts`、`server/src/ws.ts`、`do/session.ts`、`web/src/live`       | INV-01                |
| 観測（ObsLogEntry / 保持 / 測定窓）                      | [observability.md](observability.md) | `@hns/core` の observability、`server/src/obs`、`machine/src/log`               | —                     |
| GraphQL（面・失敗・上限）                                | [graphql.md](graphql.md)             | `@hns/core/graphql`、`server/src/graphql`                                       | —                     |
| 認証（入口・セッション・署名）                           | [auth.md](auth.md)                   | `server/src/edge`、`@hns/core` の codecs                                        | INV-01                |
| machine（署名・ROOT 封じ込め・操作）                     | [machine.md](machine.md)             | `@hns/core` の machine、`@hns/machine`、`do/machine`                            | INV-01 / 02 / 03      |

## 規則

- 1 面 1 ファイル。別の面の話はリンクで済ませ、同じ規則を 2 か所に書かない。
- **語彙はコードが持ち、契約はその意味と規則を書く**。列挙を写さない（写すと腐る）。表を写すのは「status のような値そのものが契約」の場合だけ。
- 契約を変える変更は、このファイル・実装・テストを同じ変更に入れる。**挙動を変えるなら決定（`design:`）として扱う**。

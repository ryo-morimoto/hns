# 契約: 失敗（failure）

2026-11-18 / L6 M2。**この面の契約の正本**。実装は [status.ts](../packages/server/src/failures/status.ts#L95) の `FAILURE_STATUS`、型は `FailureCodeOf<S>`。docs とコードの TSDoc はここを指す。

## 形

- 想定内の失敗は **面ごとに閉じたコード**（`FailureCodeOf<S>`）で返す。面が宣言していないコードはコンパイルできない。
- **code → status は 1 つの表**（`FAILURE_STATUS`）だけが決める。面は status を渡さない。
- コードの綴りは**面をまたいで 1 つ**（`invalid_request`）。同じ語が面ごとに違う意味を持つことは、面ごとの union で閉じる（下の注意）。
- **GraphQL は HTTP status を持たない**。失敗は 200 のエンベロープ内の union メンバー（`transport: "graphql"` の行は status を持たない）。

## 表（code → status → 面）

| code | status | 面 |
| --- | --- | --- |
| `unauthorized` | 401 | edge |
| `invalid_request` | 400 | edge, files, session-rpc, workspace-rpc, graphql |
| `forbidden` | 403 | graphql |
| `not_found` | 404 | edge, gateway, files, session-rpc, workspace-rpc |
| `method_not_allowed` | 405 | edge, gateway, session-rpc, workspace-rpc |
| `conflict` | 409 | files, workspace-rpc |
| `denied` | 400 | files, workspace-rpc |
| `payload_too_large` | 413 | edge, gateway, files, session-rpc, workspace-rpc |
| `unsupported_media_type` | 415 | edge, gateway, files, session-rpc, workspace-rpc |
| `upgrade_required` | 426 | edge |
| `not_implemented` | 501 | edge |
| `budget_exceeded` | 429 | gateway |
| `limit_exceeded` | 429 | session-rpc, graphql |
| `limit_unavailable` | 503 | session-rpc |
| `stopped` | 503 | gateway |
| `unavailable` | 503 | edge, gateway, files, session-rpc, workspace-rpc, graphql |
| `timeout` | 504 | edge |
| `upstream` | 502 | gateway |
| `internal` | 500 | edge, files, session-rpc, workspace-rpc |
| `lease_not_held` | 409 | files, workspace-rpc |
| `lease_expired` | 409 | files, workspace-rpc |
| `lease_epoch_stale` | 409 | files, workspace-rpc |

## 意味の注意

- `invalid_request`（REST / files / session-rpc / workspace-rpc）は **HTTP の要求が不正**。`invalid_request`（GraphQL）は **フィールドの引数が不正**。語は 1 つ、意味は面ごとに閉じた union の中で定義する。
- `limit_exceeded` は REST では 429（当月の上限）、GraphQL では union メンバー（面の上限超過）で status を持たない。
- `denied` は**書いていない**確定的な拒否（machine が書く前に止めた）。`unknown` は「適用済みか分からない」で、[workspace](workspace.md) の語。
- lease の拒否（`lease_not_held` / `lease_expired` / `lease_epoch_stale`）は status を持つので、別の写像ではなくこの表の行。

## 変わったとき

- 行を足す: 表に 1 行 + 少なくとも 1 面。表とこの表の両方を同時に直す（`satisfies Record<FailureCode, FailureRow>` が欠落をコンパイルエラーにする）。
- status を変える: 既存のテストの期待値と、この表。**status の変更は挙動の変更**なので、issue ではなく決定（`design:`）として扱う。
- コードの意味を変える: 面の union と docs を同時に。綴りを増やさない。

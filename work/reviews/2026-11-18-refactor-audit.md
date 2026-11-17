# 大レビュー監査（2026-11-18 / read-only）

対象: main b44c4e1。auditor がソース・docs・issues を読み、npm run check を 1 回実行（exit 0）して作成。数値の計測は meter の担当。

## 所見の要約

- **P0 は 1 件**: cf dev の起動コードが 6 か所に写経され、wrangler が inspector を 9229 に固定するため並列起動で落ちる。gate 不安定の直接原因。
- **契約の分裂**: 8 つの閉じた failure union と 5 か所の code→status 表。観測ログは ObsLogEntry と独自 JSON の 2 形式。
- **データ層**: 正本は obs_events / cost_turn / index_state / DO journal。D1 の events / usage_log と store の events / usage / workflows / automations repo は生産コードからの呼び出しが 0。
- **docs**: packages の export 表、limits の前半、workspace の `§`、durability の INV 台帳が実装と食い違う。
- **台帳**: D094 が 2 つ、BOARD に done のまま next の行が 6 件。0230 の重複は未コミットのワーキングツリーのみ。

## リファクタ backlog（優先度順）

| 優先度 | 対象 | 問題 | 提案 | サイズ | リスク |
| --- | --- | --- | --- | --- | --- |
| ~~P0~~ | テスト基盤 | ~~cf dev 起動が 6 ファイルに写経され、9229 を奪い合う~~ **完了 2e06041** | tools/test/cf-dev.ts に共有ランチャー + uid ディレクトリのロック + 1 回 retry。6 ファイルを置換（+580/−776）、check 5 回連続 green、9229 0/6 | M | 低 |
| P1 | 契約（失敗） | 閉じた union 8 本、code→status 表 5 か所。GraphQL は invalid_argument、REST/machine は invalid_request | server に code→status の表を 1 つ置き、各面は部分集合を宣言するだけにし、綴りを揃える | M | 中 |
| P1 | データ層（Journal） | intent/outcome/audit/event・operationId 重複排除がローカルと DO の 2 実装 | DO 側を唯一のリモート契約と明記し、ローカルは v0.1 アダプタとして outcome 変換だけ共有 | L | 中 |
| P1 | データ層（D1） | D1 events / usage_log と repo は生産側の呼び出し 0。正本は obs_events / cost_turn | 新 migration で 2 表を落として repo を削除するか、docs で「予約」と明記して公開面から外す | M | 低 |
| P1 | データ層（未使用 repo） | workflows / automations / conversations の書き込み API の呼び出し 0 | 使う issue が来るまで export せず、書き込み API を削る | M | 低 |
| P1 | 安全（fail-open） | DB binding が無いと cost gate を作らず上限なしで通る | 非 development で DB が無ければ Session を開かず失敗させる | S | 低 |
| P1 | 契約（相関 ID） | request-id の規則が 2 か所 + machine に複写 | core の OBS_REQUEST_ID_PATTERN を唯一の出所にする | S | 低 |
| P1 | docs（packages） | 存在しない面（./identity・bin）を宣言、実在の ./conversation-index・./checkpoint が無い | package.json の exports に合わせ、未実装は「未実装」 | S | 低 |
| P1 | 契約（版の語彙） | "absent" が型の外を流れる | core に AbsentVersion を置き、conflict の currentVersion と read の戻りを union に | M | 中 |
| P1 | 観測（ログの形） | index.* の 3 event が EVENT_NAMES 外の独自 JSON、約 20 の console.error | 3 event を EVENT_NAMES に足して ObsLogEntry で書き、console は観測外の欠陥ログと明記 | M | 低 |
| P2 | 重複（語彙） | OBS_DETAIL_KEYS と DetailSchema が同じ 7 キーを 2 回 | const tuple から schema を導出 | S | 低 |
| P2 | 重複（定数） | MAX_INDEX_BATCH が 50（server）と 500（agent）。既定 50 も二重 | drain 上限と API 上限で名前を分け、既定値を 1 か所に | S | 低 |
| P2 | 重複（署名） | 署名対象 6 フィールドが core と machine で 2 回宣言 | SignedHeaders を core の型から導出 | S | 低 |
| P2 | 重複（ログ） | levelOfStatus が同一実装で 2 つ | core に 1 つ置く | S | 低 |
| P2 | 重複（語彙） | JOURNAL_UNKNOWN_REASONS が core を手写し。denied の reason は string | core の配列から導出し、denied は RefusalCode の union に | S | 低 |
| P2 | GraphQL 構築 | 失敗型の enum/object 構築が写経 | failureType(name, codes) を 1 つに | S | 低 |
| P2 | 契約（status 写像） | files face が status を各呼び出しで渡す（同じ対応が 2 通り） | code→status の表を 1 つにし、呼び出しから数値を消す | S | 低 |
| P2 | テスト基盤（alias） | vitest の alias 表が package.json exports の写経で既に不足 | alias を消して exports に一本化（残すなら exports から生成） | S | 中 |
| P2 | 未使用 export | @hns/workspace/checkpoint に利用者なし | 使う面が決まるまで export を落とすか、利用を 1 か所に寄せる | S | 低 |
| P2 | ビルド（警告） | deploy stage が bare import を警告つきで捨てる（store/repositories/workflows.ts の import type） | import type にする | S | 低 |
| P2 | knip | workspace の knip entry に rooted-helper が残り hint が出続ける | entry を消して tsdown の entry だけに | S | 低 |
| P2 | 古いコードコメント | 済んだ issue を未来形で参照（edge/store.ts:27 など） | 現在の実装に合わせ、issue 番号は書かない | S | 低 |
| P2 | CHANGELOG | 全パッケージ 0.1.0 のまま第2波・第3波が未反映。agent の read_file の数値も古い | 1 パッケージ 1 節ずつ追記 | S | 低 |
| P2 | docs（workspace） | `§` が残る、MutationResult の currentVersion が core と不一致、PoC の数値を現行の証拠に | 現行 API に合わせ、PoC 節は履歴に切り出す | M | 低 |
| P2 | docs（durability） | INV 表に INV-01/02/07/08/12 の定義が無いのに参照される | INV 台帳を 1 か所にし、参照はリンク化 | S | 低 |
| P2 | docs（observability） | 死んだ pruneEvents を現行手順に、イベント表に conversation.updated/deleted が無い | 保持は obs/store の append 時 prune、表は EVENT_NAMES から生成 | S | 低 |
| P2 | docs（limits） | 0027 の PoC 面を現在形で書く | 前半を履歴に落とし、現行の制限だけ残す | S | 低 |
| P2 | docs（web-client-nfr） | packages/web/dist を出所にし 702KB/208.9KB gzip。実際は deploy/assets で 707KB/213KB | 出所と数値・日付を更新 | S | 低 |
| P2 | docs（packages・所有者） | イベントの所有者が 2 行に分裂 | 実行イベントは workspace、D1 の Event モデルは廃止、と 1 行に | S | 低 |
| P2 | 台帳（decisions） | D094 が 2 つ、D092/093 の順序も乱れ | :1307 を次の空き番号に振り直し、参照側に注記 | S | 低 |
| P2 | 台帳（BOARD） | done が open/next のまま 6 件、順番待ちの一覧が 2 つで不一致 | 表の status を done にし、一覧を 1 か所から導出 | S | 低 |
| P2 | 索引（クエリ） | 一覧の ORDER BY COALESCE(updated_at, created_at) で索引が効かない | 式索引にするか、並びを updated_at に揃える | S | 低 |
| P2 | 重複（公開面） | workspaceRoot と agentCwd が同じ値 | クライアントで導出し、agentCwd を落とす | S | 低 |

## 確認できなかったこと

- 実 deploy / DNS / 実 Cloudflare / tunnel 越しの p95 / machine 喪失。
- flake の再現率（1 回の check は green。9229 競合の発生率は meter の担当）。
- 未実装面（E2E、0167、0168、0106）はコードと docs の突き合わせのみ。
- 0230 の重複は未コミットのワーキングツリーのみ（HEAD では再現せず）。
- 各 Result の低が既に直っているかは 1 件ずつは追っていない。

## P0 実施結果（2e06041）

- tools/test/cf-dev.ts（629 行）: startCfDev → url / port / output / stop、18100–18999 の bind プローブ、$TMPDIR/hns-cf-dev-<uid>/ のロック（0700/0600、wx、5s の torn stale、takeover ガード + rename + token 一致、/proc で cf dev だけ kill、9229 bind プローブ）、起動失敗はロック内で 1 回 retry。
- 6 か所（gateway / cost / session-do / workspace-do / remote-write / objects）を置換。assertion とテスト名は不変。
- 回帰: 純関数 11 tests（tools/test/cf-dev.test.ts）。6 待機者の逐語移植で二重保持 0/60（修正前 10/10）。
- 計測: check は 43.8 → 56〜73s に伸びた（直列化）が、9229 の失敗は 0/6。review は 4 回連続 green（56/56/62/59s、887 tests、skip 0）。
- 残りの低（review non-blocking）: orphan の child を再 read の記録から取る、restart 予算に 10s を含める、takeover 直後の孤児回収、pre-commit の tools project、npm run fmt の対象、.tmp の掃除、spawnCfDev の mode 引数。

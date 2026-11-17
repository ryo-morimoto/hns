# 0181: store の鮮度方針を画面ごとに決める

status: in-progress
priority: now
design: agreed
design-ref: D097
depends-on: 0159, 0179
touches: packages/web/src/live/, packages/web/src/app/, packages/web/test/, work/issues/0181-store-freshness.md

## Goal

Relay の store は、満たせる要求を network に行かない。実測では再訪 0 回。これは DO RPC を減らすが、
裏返すと**古いデータを出したまま何も聞きに行かない**。鮮度が意味を持つ画面（Needs you など）で
どう更新するかを決める。

## Acceptance criteria

- [x] store が古いまま表示されるケースを列挙する（再訪、購読の取りこぼし、切断中の変更）
- [x] 画面ごとに「購読（0159）」か「明示的な再取得」を決め、テストで固定
- [x] 切断・再接続時の表示を決める（状態を隠さない）
- [x] `store-or-network` の既定を画面ごとに変えられるようにする
- [x] `npm run check` が通る

## Notes

- 実測: store-or-network で再訪 0、既定ポリシーで毎回 1（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §13）
- 0159 の WS は送信が無料・受信が 20:1 なので、購読に寄せると DO 課金は増えない
- 索引（0149）の遅れと store の古さは別の層。両方を説明できるようにする

## Design（D097 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D097）。

### 前提

- Relay の store-or-network は再訪 0 回（PoC RESULTS §13）。裏返すと**古いまま何も聞かない**。
- 0159 の WS は live frame（snapshot / append / delta / error）と client→server の `ping` / `resync`。
- 0149 の D1 索引の遅れと、Relay store の古さは**別の層**。両方を説明できるようにする。

### 決定 1: 古いまま出るケース

1. 同じ画面を再訪（store が残っている）
2. WS の取りこぼし（切断中の frame、reconnect の隙間）
3. 別タブ / 別端末 / agent の変更
4. 索引（0149）の反映遅れ
5. 画面を開いたまま時間が経つ（Needs you など）

### 決定 2: 画面ごとの方針

| 画面 | 初回 | 更新 | 根拠 |
| --- | --- | --- | --- |
| 会話の transcript | network | **購読**（0159）+ reconnect で resync | 変更が速い |
| 会話一覧 / ホーム / Needs you | store-and-network | **購読**（一覧の追加・状態）+ 変更後に refetch | 古いと判断を誤る |
| Settings / providers / machines | store-and-network | 30 秒 TTL + focus / 表示時に revalidate。購読しない | 変更が遅い |
| Editor の本文 | network（版付き） | 保存の conflict で検出。store に載せない | 版が正本 |
| file tree | network（展開ごと） | 購読しない。操作後に再取得 | 0125 の lazy |

- `store-or-network` を既定にし、画面ごとに `network-only` / `store-and-network` を選べるようにする（query の fetchPolicy）。

### 決定 3: 切断・再接続

- 切断中は **最後のデータ + 「再接続中（古い可能性）」** を出す。状態を隠さない。
- 再接続で `resync` を送り、**開いている画面を refetch** する。取りこぼしを store の差分だけで埋めない。
- `error` frame / close は型付きで UI に出す。

### 決定 4: 索引の遅れ

- 一覧は D1 索引（0149）を読む。索引が遅れている間は「更新中」を出し、WS の live で開いている会話だけ先に更新する。
- 索引の遅れを store の古さと混ぜない（別のバナー / 別の説明）。

### 決定 5: 取得の作法

- ポーリングをしない。focus / visibilitychange / 明示操作 + TTL で revalidate。
- 画面を離れたら購読と in-flight を abort する。

### 決定（D097）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 既定の fetchPolicy | **決定（user）**: store-or-network。画面ごとに上書き | 0179 / 0105 | 2026-11-17 |
| U-02 | 購読する画面 | **決定（user）**: transcript / 一覧 / ホーム。設定・machine は購読しない | 0159 | 2026-11-17 |
| U-03 | reconnect の resync | **決定（user）**: `resync` + 開いている画面の refetch | 0159 | 2026-11-17 |
| U-04 | 古さの表示 | **決定（user）**: 「再接続中」「更新中」を別々に。黙って出さない | 0105 / 0110 | 2026-11-17 |
| U-05 | TTL | **決定（user）**: 設定系は 30 秒。focus で revalidate | 0114 | 2026-11-17 |

### 決定 6: 実装の形（2026-11-17）

方針の表は `packages/web/src/app/freshness.ts` の `FRESHNESS` 1 箇所。`useScreenRead` が
`useLazyLoadQuery` の `fetchPolicy` に反映し、TTL の画面は再取得（`fetchQuery`）を自分で持つ。

| 画面 | 入口 / クエリ | fetchPolicy | TTL | 購読 | 理由 |
| --- | --- | --- | --- | --- | --- |
| ワークスペース一覧（サイドバー上） | `ShellProjectsQuery` | `store-and-network`（TTL 内は `store-or-network`） | 30 秒 + focus | なし | project の追加・改名を運ぶライブ配信が無い（0159 は会話単位）。開くたびに問い合わせると RPC だけが増えるので、30 秒は store で答え、過ぎたら network も走らせる |
| ワークスペース（会話・タスク一覧） | `ShellWorkspaceQuery` | `store-and-network` | なし | なし（0159 は会話単位） | Needs you の判断に使うので古いまま出すと誤る。一覧を運ぶライブ配信は無いので、store を見せたまま開くたびに network で読み直し、切断中に増えた会話は再接続の refetch で拾う。開いている会話の title だけは WS が store に写す |
| 会話の transcript | 会話画面（`LiveConnection`。クエリは 0105） | `network-only` | なし | あり（0159 + 再接続の snapshot） | cursor で追う live view で、store の版は cursor を持たない。取りこぼしを差分で埋められないので store を正本にしない |
| Settings / providers / machines | 未実装（0107） | — | — | — | 作るときに 30 秒 TTL の行を足す（`SLOW_SCREEN_TTL_MS` を再利用） |

- 既定は `store-or-network`。`FreshnessPolicy` は「既定を破る画面」だけを持つ型で、`reason` が必須。
  購読も TTL も無く、mount でも network を読まない画面は、表のテストが拒否する（二度と更新されない）。
- `store-only` は型から除外する。store が空 / GC 済みのときに読み込みが終わらないため、TTL の内側は
  `store-or-network`（store が答えれば network に行かない）で表す。
- TTL の内側は `store-or-network`（store が答えれば network に行かない）、外側がその画面の
  `fetchPolicy`。境界は `now - lastFetchedAt >= ttlMs` で切れる（半開区間）。
- TTL の起点は、network を使って read が画面に載った時刻。初回の read が失敗したときは何も
  記録しない（空の store を fresh と覚えない）ので、次の訪問は必ず network に行く。
- focus の再取得は**成功したときだけ**窓を更新する。失敗したら窓は古いままなので、次の focus で
  もう一度読む（黙って新しい 30 秒にしない）。Relay は再取得の失敗を throw せず古い一覧を残す
  ため、「失敗を fresh と数えない」ことがここでの約束。失敗を見せるバナーは 0106。
- **一覧の購読はしない（D097 の U-02 からの差分）**。0159 の WS は 1 会話単位で、一覧を購読するには
  server / protocol の拡張が要る。この lane では実装せず follow-up（下の「未確定」）。D097 の
  「会話一覧も購読」は、開いている会話の title を WS が store に写す形で部分適用している。
- project 未選択の `ShellWorkspaceQuery` は `store-or-network` のまま。選択が空の要求を network に
  出さない（0179 の「request を送らない」を維持）。このとき `useScreenRead` は mount を記録するが、
  workspace に TTL は無いので誰も読まない。
- WS の frame は `applyLiveFrameToStore` が store に書く。書くのは `snapshot` の `title` だけ
  （一覧が持つ列が title だけ）。title は plain string なので空の title もそのまま書く。一覧に無い
  会話の frame は record を作らない。
- 再接続（`reconnecting` → `online`）で開いている画面の `ShellWorkspaceQuery` を refetch する。
  transcript は再接続時の snapshot が置き換える（0159）。
- その refetch は server が読んだ時点の title を返すので、live の title が巻き戻らないよう
  `reapplyLiveTitles` で snapshot の title を書き戻す（会話ごとに最後の snapshot title を保持し、
  画面を離れたら `forgetLiveTitle` で捨てる）。
- 再接続で `resync` は送らない。新しい socket に server が必ず snapshot を返すので（0159 C3）、
  resync は同じ取り直しを二度要求するだけ。resync は接続を保ったまま取り直す経路として残る。
- 「古い可能性」の文言は会話画面（0105 / 0106）のコピー。ここが固定するのは、切断中も状態
  （`reconnecting` / `offline`）と最後のデータを出したままにすること（隠さない）。
- 切断中の表示は 0159 のまま（「再接続中」「未接続」）。最後のデータを出したまま状態を隠さない。
- 実 WS の経路（snapshot / append / 再接続 snapshot）は 0159 の integration harness が持つ。
  ここは frame → store の写像と、fake socket 越しの画面の振る舞いまで。web の test project は
  jsdom で server / cf dev を立てないため、実 WS の snapshot → store を 1 本にするには E2E（0043）が
  要る（この lane では不可）。
- network-only の conversation 行は画面が無いので未配線。0105 が transcript のクエリを足すときに
  `freshness.ts` の `conversation` 行をそのまま使う。

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 再訪 → store のデータ → 画面方針どおりに refetch / 購読が動く | 高 | 受入1・2 |
| C2 | WS を切る → 変更 → 再接続 → resync + refetch で最新になる | 高 | 受入3 |
| C3 | 切断中 → 「再接続中（古い可能性）」が出る。黙って古い値を出さない | 高 | 受入3 |
| C4 | 設定画面 → 30 秒以内の再訪は store、focus で revalidate | 中 | 受入4 |
| C5 | 索引の遅れ → 「更新中」が出て、store の古さと混ざらない | 中 | 受入4 |
| C6 | 画面を離れる → 購読 / in-flight が abort される | 中 | 受入5 |
| C7 | `npm run check` | 高 | — |
| C8 | 再訪 → project 一覧は TTL 内なら network 0、会話・タスク一覧は network 1（store を出したまま） | 高 | 受入1 |
| C9 | TTL の境界 → 29.999 秒は store、30.000 秒は network | 中 | U-05 |
| C10 | focus → TTL 内は再取得しない、TTL を過ぎていれば再取得する | 中 | C4 / U-05 |
| C11 | WS の snapshot → store の conversation title が変わり network 0。一覧に無い会話の frame は record を作らない | 高 | 受入2 |
| C12 | 切断 → 再接続 → 開いている画面の一覧を refetch する。初回接続では refetch しない | 高 | 受入3 |
| C13 | network-only の画面（transcript）→ store に記録があっても `store-or-network` を選ばない | 中 | 受入3 |
| C14 | WS の snapshot で title が変わる → 切断 → 再接続 → refetch が title を巻き戻さない | 高 | レビュー blocking 1 |
| C15 | focus の再取得が失敗 → 窓を更新しない → 次の focus でもう一度読む（古い一覧を黙って固定しない） | 中 | レビュー 低 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| C1 / C8 | 再訪で store を使う / 使わない | デシジョンテーブル | component（jsdom） | `packages/web/src/app/Shell.test.tsx`「a revisit inside the TTL skips the project list」 |
| C2 / C12 | 再接続の refetch と初回接続 | 故障注入・デシジョンテーブル | component（jsdom） | `Shell.test.tsx`「a reconnect refetches the open screen's lists」、`packages/web/src/app/LiveConnection.test.tsx`「a recovered connection is reported…」 |
| C3 | 切断中の表示 | 状態遷移 | component（jsdom） | `LiveConnection.test.tsx`、`Shell.test.tsx`「a conversation route shows the live status…」 |
| C4 / C9 / C10 | TTL の境界と focus | 境界値分析 | unit + component | `packages/web/src/app/freshness.test.ts`「up to its TTL」、`Shell.test.tsx`「revalidates on focus only after its window」 |
| C5 | 索引の遅れ | — | — | 出さない: 索引の反映遅れは 0149 の層で、この issue は store の古さだけを持つ（D097 決定 4） |
| C6 | 画面を離れたら abort | 状態遷移 | unit | `packages/web/src/live/client.test.ts`「closing the client stops reconnecting」（既存、変更なし） |
| C11 | WS → store | 状態遷移 | unit + component | `packages/web/src/live/store.test.ts`（title の反映 / 一覧に無い会話 / 空 title）、`Shell.test.tsx`「patches the conversation title without a read」 |
| C14 | refetch 後の live title | 状態遷移 | unit + component | `store.test.ts`「a list read that overwrote the live title is corrected」「a closed conversation stops holding its live title」、`Shell.test.tsx`「a reconnect refetch keeps the live title」 |
| C15 | 失敗した再検証 | 故障注入 | component（jsdom） | `Shell.test.tsx`「a failed focus revalidation is retried on the next focus」 |
| C13 | network-only が store を読まない | 同値分割 | unit | `freshness.test.ts`「the conversation screen never reads the store」 |
| C7 | ゲート | — | static | `npm run check` |

- C3 の「古い可能性」という文言は 0105 / 0106 のコピー。ここでは状態が隠れないこと（ラベル /
  `data-state` / 最後のデータ）を固定する。

## Log

- 2026-11-17: D097 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

## 未確定 / follow-up

- U-06: 会話・タスク一覧の購読。D097 の U-02 は一覧も購読すると決めたが、0159 の WS は 1 会話単位で、
  一覧を購読するには server の frame に一覧の変更を載せ、client の store に写す拡張が要る
  （server / protocol の変更なのでこの lane の外）。必要になったら別 issue（touches は server + web）。
  それまでの一覧の鮮度は、開くたびの read + 再接続の refetch + 開いている会話の title の live 写像。

## やらないこと

- offline-first / 楽観更新の一般化

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-17: 0160 の後に lead が `next` から `now` へ。画面ごとの store / network / 購読の方針を決めて実装する。
- 2026-11-17: 実装。`app/freshness.ts` に画面→方針の表（`FRESHNESS`）と `useScreenRead`（mount の
  `fetchPolicy` と TTL の再取得）、`live/store.ts` に frame → store、`live/client.ts` に `onFrame`、
  `LiveConnection` に再接続の通知、Shell に fetchPolicy / 再接続の fetchKey の適用。0179 の
  「同じ画面を 2 回開いて network 0」は、一覧の鮮度を優先して画面ごとに置き換えた（project 一覧だけが
  TTL 内 store、会話・タスク一覧は開くたび network）。
- 2026-11-17: `npm run check` exit 0（42.9s、web 88 tests / 20 files。lint・fmt・codegen・typecheck・
  unit・integration・build・deploy・knip を含む）。受入 4/4。レビュー待ち（未割当）。
- 受入の証拠:
  - 表: `app/freshness.ts` の `FRESHNESS`（projects / workspace / conversation）と `freshness.test.ts`
    （既定を破る画面は理由を持つ / どの画面も購読・TTL・mount の read のどれかで新しくなる / TTL の境界 /
    network-only は store を読まない / 購読するのは会話画面だけ）。
  - クエリへの反映: `Shell.test.tsx`「a revisit inside the TTL skips the project list」が、再訪で
    `ShellProjectsQuery` 0 回・`ShellWorkspaceQuery` 1 回を数える。
  - WS → store: `live/store.test.ts` と `Shell.test.tsx`「a live snapshot patches the conversation
    title without a read」が、frame だけで sidebar と見出しの title が変わり network 0 を確認。
    再接続の refetch が title を巻き戻さないことも `Shell.test.tsx`「a reconnect refetch keeps the
    live title」で固定（修正前は赤）。
  - 再接続: `Shell.test.tsx`「a reconnect refetches the open screen's lists」と
    `LiveConnection.test.tsx`「a recovered connection is reported…」。
  - 既存の挙動: 0179 の「再訪 0」だけを一覧のために置き換え、project 未選択で request を送らないこと
    （0179 C3）と 0159 の切断表示は変えていない。既存 web テストは全て通る。
- 2026-11-17: レビュー BLOCKED（blocking 2 / 低 7）→ 修正。指摘ごとに commit を分けた。
  - blocking 1（`ad354c4`）: 再接続の refetch が live の title を巻き戻す。会話ごとの最後の
    snapshot title を `live/store.ts` に保持し、一覧を描く Shell の commit 後に `reapplyLiveTitles`
    で書き戻す。画面を離れたら `forgetLiveTitle` で捨てる。再現テストは `Shell.test.tsx`「a reconnect
    refetch keeps the live title」で、修正前は "Web の土台" に戻って赤だった。
  - blocking 2（`da7035a`）: workspace を `subscribes: false` にし、表・決定 6・テストを
    「購読なし（0159 は会話単位。一覧の購読は server / protocol の拡張が要る）」に直した。一覧の購読は
    U-06 として follow-up にした（この lane では実装しない）。
  - 低（この commit）: `SLOW_SCREEN_TTL_MS` の TSDoc を projects に / `store-only` を型から除外 /
    空 title もそのまま書く / project 未選択時の記録を TSDoc / focus の再取得は**成功したときだけ**
    窓を更新し、失敗は次の focus で再試行（C15）/ resync を送らない理由を決定 6 に明記 / 実 WS の
    snapshot → store は web の E2E（0043）が要ると明記。
  - `npm run check` exit 0（38.5s、849 tests、web 93 tests）。HEAD でも再実行して exit 0（41.7s、
    849 tests）。1 回目は machine-integration の `cf dev` が port 衝突（"Address already in use"）で
    1 本落ち、再実行で緑。web の変更とは無関係の環境要因。

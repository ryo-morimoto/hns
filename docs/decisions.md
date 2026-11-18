# Decisions

追記専用の決定ログ。**1 決定 1 ファイル**（このディレクトリ）。新しいものが下。変更は新しいエントリで置き換え、置き換えたことを書く。

番号で参照する（D094）。ファイル名は番号だけなので、リンクは decisions/D094.md。

| 番号 | 決定 |
| --- | --- |
| [D001](D001.md) | Pi Durable 1.5.0 を固定し、ExecutionEnv を境界にする |
| [D002](D002.md) | リポジトリ構成（README / ARCH / docs / work） |
| [D003](D003.md) | MVP は 1マシンで「会話→編集→差分→再開」 |
| [D004](D004.md) | マシン側は A（中央 + pi-env/SSH）で開始する |
| [D005](D005.md) | Agent の Tool は Workspace と sandbox を経由する |
| [D006](D006.md) | 次は Editor、Provider は鍵が来てから |
| [D007](D007.md) | 最初の実 Provider は Ollama Cloud |
| [D008](D008.md) | 2つ目の Provider は OpenCode Go |
| [D009](D009.md) | 統合 MVP は単一プロセス + SQLite + ポーリング UI |
| [D010](D010.md) | 進捗は SSE、未完了タスクは inspect から |
| [D011](D011.md) | UI は最後。最終段で UX に集中する |
| [D012](D012.md) | Workflow は当面サーバ内で逐次実行する |
| [D013](D013.md) | Automation は Firing だけ持ち、実行は Workflow に委譲する |
| [D014](D014.md) | アプリの入口は token、既定は loopback |
| [D015](D015.md) | バックアップは VACUUM INTO、復元は停止中に |
| [D016](D016.md) | tailnet の ID を認証に使う |
| [D017](D017.md) | passkey は WebAuthn + セッション cookie |
| [D018](D018.md) | 秘密は user / service のスコープに分ける |
| [D019](D019.md) | PRF で包み、ログイン中だけ復号する |
| [D020](D020.md) | 1つの DEK をパスキーと復旧コードで包む |
| [D021](D021.md) | 2台目のパスキーは unlocked セッションで追加する |
| [D022](D022.md) | 制限はアプリ層でかけ、中断は conversation.abort |
| [D023](D023.md) | 観測は events テーブルに集約する |
| [D024](D024.md) | 会話は論理削除、root は消さない |
| [D025](D025.md) | sandbox は検出して fail closed |
| [D026](D026.md) | 技術スタックを固定する |
| [D027](D027.md) | 型が正本（type first） |
| [D028](D028.md) | AI slop はゲートで止める |
| [D029](D029.md) | パッケージは 6 つで始める |
| [D030](D030.md) | 型は不変条件を持つパッケージに置く |
| [D031](D031.md) | 境界は valibot、エラーはコード、遷移は1箇所 |
| [D032](D032.md) | Node 24 を flake で固定する |
| [D033](D033.md) | exec は Linux の bubblewrap だけで提供し、他は出さない |
| [D034](D034.md) | TOCTOU は openat2 ではなく exec する helper で閉じる |
| [D035](D035.md) | Node 26（最新系列）へ上げる |
| [D036](D036.md) | workspace は core のファイル DTO を借り、helper はパッケージ同梱のプログラムとして exec する |
| [D037](D037.md) | agent の失敗は値で返し、できる操作は型で分ける |
| [D038](D038.md) | テストは Vitest 1本と node:assert、層は5つ |
| [D039](D039.md) | 会話ランタイムは pi-durable 一択とし、pi-agent-core は採用しない |
| [D040](D040.md) | 実装後は独立レビューを1回通し、直した diff も再レビューする |
| [D041](D041.md) | レビューを 原則・手順・不変条件の3層に分け、不変条件は条件で読む |
| [D042](D042.md) | 設計判断とレビュー観点には原典リンクを付ける |
| [D043](D043.md) | Web UI を画面単位で前倒しする（contract-first / fixture 併用） |
| [D044](D044.md) | 型検査は tsrs（Rust 版 tsc）で行う |
| [D045](D045.md) | 調査・要件・技術選定の進め方を docs/procedures/process.md に置く |
| [D046](D046.md) | UI/UX と Agentic Workspace の Golden Example を作業前後の参照に置く |
| [D047](D047.md) | 正本を Cloudflare に置き、実行は手元に残す |
| [D048](D048.md) | 正本の単位は (C, J) とし、ack は単一システムで閉じる |
| [D049](D049.md) | Durable Object は調整の単位にだけ使う |
| [D050](D050.md) | コミット時チェックはステージ済みのパッケージに限定する |
| [D051](D051.md) | コミットは速い層、push は全部。層は「プロセス」で分ける |
| [D052](D052.md) | フックは prek に通し、ステージ内容と merge をゲートで覆う |
| [D053](D053.md) | 接続・計算・ライブ更新の言い方を訂正する |
| [D054](D054.md) | 優先度は now / plan / batch / hold の4つで表し、agent は now だけを着手する |
| [D055](D055.md) | Web の契約を GraphQL、クライアントを Relay にする |
| [D056](D056.md) | テストのアサーションは Vitest の expect に統一する |
| [D057](D057.md) | テスト管理は TSDoc 契約 + コロケート/インソーステスト + doctest にする |
| [D058](D058.md) | tiers の二重実行を廃止し、シナリオは1層1回にする |
| [D059](D059.md) | core は「系が合意する語彙」とし、REST は面ごとに実装する |
| [D060](D060.md) | 実行レーンは最大3本にし、増やす条件を固定する |
| [D061](D061.md) | テストの型の絞り込みは expect.assert を使う |
| [D062](D062.md) | アサーションは expect を主とし、型の絞り込みには node:assert も使う |
| [D063](D063.md) | 配備は cf の modes と tools/deploy の cloudflare.config.ts で行う |
| [D064](D064.md) | store は D1 専用にし、node:sqlite を削除する |
| [D065](D065.md) | CLI は cf に統一し、wrangler を直接使わない |
| [D066](D066.md) | 並列の単位をパッケージからファイル（サブツリー）にする |
| [D067](D067.md) | 完了は構造化レコードで表し、Result への追記をやめる |
| [D068](D068.md) | 四半期のテーゼと Moat 台帳を持ち、成果の層を運用に入れる |
| [D069](D069.md) | レビューを4層に分け、月次で判断を蒸留する |
| [D070](D070.md) | 製品のループは外部に開き、hns は判断と記録だけを持つ |
| [D071](D071.md) | 仕事の記録を @hns/record に切る |
| [D072](D072.md) | Worker の D1 binding と migration の版ファイル |
| [D073](D073.md) | GraphQL の schema は Query の factory から組む |
| [D074](D074.md) | web は Relay 20.1.1 で読み、schema は server から生成する |
| [D075](D075.md) | codegen をゲートの前段に入れ、生成物のヘッダを検査する |
| [D076](D076.md) | 設計の合意を priority と別の軸にする |
| [D077](D077.md) | GraphQL 以外の面を、実装する issue が1つの表で宣言する |
| [D078](D078.md) | 会話の索引は D1 の conversations を使い、DO の dirtyAt から再送する |
| [D079](D079.md) | 入口の認証を A Native（passkey + PRF + デバイス鍵）にし、Access と tailnet を既定にしない |
| [D080](D080.md) | Project を信頼境界にし、会話の同一性を (project_id, id) にする |
| [D081](D081.md) | Web の umbrella 0036 を 0103–0114 + 0160 に吸収する |
| [D082](D082.md) | 0039 を 0162（events / metrics）と 0163（usage）に吸収する |
| [D083](D083.md) | 0049 は usage / inspect と server の pi-durable 除去に絞る |
| [D084](D084.md) | Command palette は registry を1つ持ち、画面に無い command は help にだけ出す |
| [D085](D085.md) | provider 鍵は gateway の deploy secret のまま、カタログは agent の静的表、検証は gateway の chat を 1 token |
| [D086](D086.md) | Workflow の run は Session DO が実行し、D1 は索引にする |
| [D087](D087.md) | Machine は D1 のレコードと2方向の鍵で登録し、疎通は Worker→machine の probe |
| [D088](D088.md) | 実プロバイダは gateway を service binding で呼び、streaming は既存の live に載せる |
| [D089](D089.md) | file tree / search は GraphQL、content は REST。除外は metadata + 既定セット + .gitignore |
| [D090](D090.md) | OpenShell 由来の5つの機構を採らない |
| [D091](D091.md) | ツール呼び出しの capability 契約を Phase 0/1 で実装する |
| [D094](D094.md) | 優先度の語彙を now / next / later / parked にする |
| [D092](D092.md) | Editor は CodeMirror 6（暫定）で、content は REST・tree は GraphQL |
| [D093](D093.md) | workspace の helper は常駐 child にして、NDJSON で hash / read / commit を多重化する |
| [D107](D107.md) | UI は Workers Assets + 手動 SPA fallback で配り、typed client は Relay の codegen にする |
| [D095](D095.md) | machine の sandbox は egress deny / `.git` 読み取り専用 / 固定 hide / HOME=root で合意する |
| [D096](D096.md) | 安全の再評価は CSRF を SameSite + JSON + WS Origin で守り、事故の封じ込めを docs とテストで固定する |
| [D097](D097.md) | Relay の既定は store-or-network で、画面ごとに購読 / TTL / network を選ぶ |
| [D098](D098.md) | code mode の profile は ConversationMetadata に置き、subagent を独立軸にし、UI は Direct / Code / Delegate |
| [D099](D099.md) | 製品 E2E は `cf dev` + 別 Vite で回し、テスト専用 seed と workers=1 / shard で運用する |
| [D100](D100.md) | Worker → machine の署名は control-plane 鍵、device key は machine → Worker |
| [D101](D101.md) | E2E のブラウザ行列に Firefox と mobile Firefox を足す |
| [D102](D102.md) | Office のエンジンは ibisOffice のみとし、LibreOffice のフォールバックを持たない |
| [D103](D103.md) | プレビューと派生は machine のキャッシュに置き、既存の Session 認可で配信する |
| [D104](D104.md) | Trail を主単位にし、Task/カンバンを置き換える |
| [D105](D105.md) | 実行層はマシン + bwrap を維持し、インフラを複雑にする変更は two-way door にする |
| [D106](D106.md) | git remote とオフライン review は Artifacts B（R2 正本 + ミラー）で取る |

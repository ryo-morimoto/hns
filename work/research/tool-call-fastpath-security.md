# 改変不能なツール呼び出しとセキュリティ制御の実現可能性

2026-11-17 / 調査記録（決定ではない） / 起点: [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) v0.1.8（main `e8ba30f`、2026-11-16）

調査方法: OpenShell は公式 docs とコードの静的読解（ビルド・実測はしていない）。hns の数値は既存の実測。製品・論文は 2026-11-17 時点の一次情報。

hns に「エージェントが書き換えられない高速なツール呼び出し」と「セキュリティ制御」を組み込めるかを、OpenShell と周辺の既製品・論文から構造化し、**採用 / 不採用 / 要検証**に分類した。この段階では [decisions.md](../../docs/decisions.md) に決定を書かず、この記録と未確定台帳（§9）で管理する。

## 0. 結論

**OpenShell の本質は「sandbox の作り方」ではなく、権限の強制（実行時）と権限の変更（承認時）を別の場所に置き、どちらもエージェントから書き換えられなくしたこと。** hns に必要なのは OpenShell の再実装ではなく、次の 4 つの不変条件を hns の語彙で持つことだ。

| ID | 不変条件 | hns での置き場所 |
| --- | --- | --- |
| R1 | ツール定義（名前・スキーマ・実装・リスク分類）はモデルから変更できない | D1/DO のツール台帳 + マニフェストハッシュ。Machine Agent が同じ束を照合 |
| R2 | 承認した呼び出しと実行する呼び出しは同一バイト列（正規化してハッシュ） | 正規化 JSON + SHA-256。判定後・実行前に再計算し、不一致は拒否 |
| R3 | 権限は単調にしか増えない。拡大は人（または明示的な設定）の承認が要る | 署名付き capability grant + epoch。モデルは提案だけ |
| R4 | 決定と実行の記録は追記専用で、エージェントから消せない | DO のイベント + ハッシュ連鎖、Cloudflare R2 へ退避 |

**速度の結論は「transport を速くする」ではない。** 実測 1 op 28ms のうち、transport の framing は 0.1ms 級（§2.3）。効くのは (a) per-op のプロセス起動をなくす、(b) per-call の DO 往復を capability lease に置き換える、(c) 読み取り系を並列・キャッシュする、の 3 つ。OpenShell の「1 接続・多重化・ローカル判定」はこの (a)(b) の設計根拠になる。

分類の集計（§4、46 要素）: **採用 30 / 不採用 9 / 要検証 7**。

最初に着手する 3 系統:

1. **canonical call envelope とツールマニフェストのハッシュ固定**（R1/R2。依存追加なし、1〜2 日）
2. **capability lease**（DO が署名して発行、Machine Agent がローカル判定。R3 と速度を同時に解く。1〜2 週）
3. **常駐 helper（Phase 1）と bwrap への seccomp 追加（Phase 2）**（0191 の write <10ms と、io_uring/AF_VSOCK の穴を塞ぐ）

やらないと決めた主なもの（[D079](../../docs/decisions/D079.md) で決定）: seccomp user notification によるネットワーク仲介、TLS MITM による資格情報注入、Z3 による形式検証、Kubernetes/マルチランタイム対応、middleware による呼び出し書き換え。**OpenShell 自体の採用も見送る**（Rust の control plane、Docker/VM 前提、PostgreSQL/Helm が hns の配備と合わない）。設計要素だけを採る。

**実現可能性の判定**:

| 狙い | 判定 | 根拠 |
| --- | --- | --- |
| 書き換えられないツール呼び出し | **実現可能** | 既存の defineTool と operationId を拡張する。新しい runtime を足さない |
| 高速なツール呼び出し | **条件付きで実現可能** | lease と helper で 28ms → 5ms を狙える。モデルの推論待ち（秒）は別問題 |
| OpenShell 型のセキュリティ制御 | **一部実現可能** | fs / process / policy / 監査は採れる。egress と資格情報は要検証。seccomp-notify / TLS MITM / Z3 は不採用 |

## 1. 問題の定義

### 1.1 誰の、どの場面か

hns の利用者は、自分のマシンでエージェントを走らせる開発者と、複数マシンを 1 つの UI から運用する管理者。場面は「モデルがツールを選び、DO が認可し、マシンが実行する」1 往復。失敗すると、workspace の外への書き込み、意図しない外部通信、資格情報の持ち出し、監査できない実行が起きる。

現在の行動は、bwrap の mount namespace で root の外を読み取り専用にし、exec が使えなければ bash を登録しない、という**粗いが fail closed な封じ込め**。足りないのは「どのツールを、どの引数で、どこまで」を毎回決める層と、決めた内容が実行まで改変されない保証、そして決定の監査。

### 1.2 「書き換えられない」の 4 分解

「書き換えられない」は 1 つの性質ではない。依頼の文言だけではどれを指すか特定できないため、実装も検証も違う 4 つに分解し、それぞれの現状と採否を分ける。以下、不変条件 R2 は「呼び出しの同一性」を指し、ストレージの Cloudflare R2 と区別する。

| ID | 意味 | 攻撃の例 | hns の現在地 |
| --- | --- | --- | --- |
| R1 | **定義の不変性**: ツール名・説明・引数スキーマ・実装がモデルに変更されない | ツール説明への指示埋め込み（tool poisoning）、実装の差し替え（rug pull） | defineTool はサーバ側コードで、モデルは変更できない。ただし**ハッシュ固定と起動時照合はない** |
| R2 | **呼び出しの不変性**: 認可した引数と実行する引数が同一 | 認可後の書き換え、重複キー/Unicode/パス正規化のズレ、TOCTOU | operationId は callId 由来でモデルは再演できない。ただし**正規化・ハッシュ・再照合はない** |
| R3 | **権限の不変性**: エージェントが自分の権限を広げられない | ポリシー改変、grant の再利用・すり替え、期限切れの無視 | Workspace DO の lease と epoch はある。**ツール権限の grant はまだない** |
| R4 | **監査の不変性**: 決定と実行の記録を消せない | ログ削除、順序の入れ替え、実行だけして記録しない | イベントは DO にあるが、**ハッシュ連鎖・外部退避はない**（[safety.md](../../docs/safety.md) の「監査の改ざん」） |

OpenShell の MCP L7 検査は R2 の一部（ヘッダーと body の一致、重複ヘッダー拒否）を、binary identity の SHA-256 pin は R1 の一部を、prover と人承認は R3 を、OCSF ログは R4 の材料を実装している。**4 つを 1 つの機構で解こうとしない**のが学び。

### 1.3 「高速」の 5 分解

| ID | 意味 | 現在の実測・見積もり | 目標（案） |
| --- | --- | --- | --- |
| L1 | 呼び出しあたりの固定費（判定・起動・transport） | 1 op 28ms（p95 61ms）。helper 起動は probe 77.7ms / write 154.6ms | ローカル判定 p50 ≤ 1ms、p95 ≤ 5ms。read 系 end-to-end p95 ≤ 30ms |
| L2 | 往復回数（DO・マシン・モデル） | 1 turn 4 op で 181ms。write は DO 1 往復 | 読み取り・許可済み操作は 0 往復（lease）。write は現状維持 |
| L3 | 承認の待ち時間 | 人承認は現状ない | 事前承認（grant）で 0。拡大時だけ人 |
| L4 | モデルの往復回数 | ツール結果の JSON をモデルが読む | スキーマとエラーコードで再試行を減らす（評価で確認） |
| L5 | 起動時間 | bwrap 起動 + ツール本体 | セッション単位の sandbox 再利用。bash 1 回の上乗せ p50 ≤ 30ms |

「高速化」の議論で L1 と L2 を混ぜない。OpenShell の 1 接続多重化は L1/L2 に効くが、モデルの推論待ち（秒）は変わらない。

### 1.4 判断基準

各要素を次で見る。

1. **守るもの**: どの攻撃・事故を減らすか（R1〜R4 のどれか）。
2. **遅延**: L1〜L5 のどこに効くか。数字がなければ「未計測」と書く。
3. **実装コスト**: 今の TypeScript / Node / Cloudflare で書けるか。ネイティブ helper が要るなら、仕様とテストを先に固め、言語刷新も含めて見積もる（言語は固定しない）。
4. **依存と成熟度**: 新しい runtime・サービス・言語を増やすか。誰が保守するか。
5. **戻せるか**: 設定で無効化できるか。データや監査を壊さずに戻せるか。

**前提の置き方**: Machine Agent の言語は TS に固定しない。開発速度を優先して今は TS を選んでいるが、仕様が明確でテストが使えるなら Rust / Zig / C への全面刷新はコストではなく選択肢である。また、hns の能力集合（ツールとポリシーの語彙）が小さいのは現時点の性質で、将来も小さい保証はない。以下の「今は採らない」は、この 2 つを前提にした暫定判断であり、言語や能力集合の変化だけでは覆らない理由（境界の複雑さ・遅延・R2 との衝突）を各項に書く。

「採用」は今の四半期に着手してよいもの、「要検証」は小さく試してから決めるもの、「不採用」は今の前提では採らないもの（前提が変われば再評価）とする。

### 1.5 何が分かれば判断が変わるか

- capability lease の失効が 1 秒以内に効き、リプレイが防げるなら、per-call の DO 認可を捨てられる（L2 が消える）。
- bwrap 内で Landlock を重ねても NixOS カーネル 6.18 で壊れず、read 拒否が表現できるなら、読み取り制御の設計が変わる。
- seccomp の追加が bash の p95 を 5ms 以上悪化させるなら、io_uring 遮断の優先度が下がる。
- 正規化 JSON のハッシュが JS と Rust/Go で一致しないなら、マニフェストを単一実装に閉じる必要がある。
- ツール権限の拡大を人の承認なしに自動化してよい水準が定義できるなら、OpenShell の auto-approve に近づけられる。

### 1.6 脅威モデル

| 資産 | 攻撃者 | 入口 | 効く制御 |
| --- | --- | --- | --- |
| workspace のファイル | 悪意ある repo・依存・ツール出力 | bash、read_file、symlink、TOCTOU | bwrap、パス正規化、引数制約、版チェック |
| ホストの資格情報 | 同上 | bash、read_file、env | hide、credential broker、短命 token |
| 外部サービス | プロンプト注入を受けたモデル | ツール呼び出し（egress） | grant の scope、egress allowlist、L7 |
| 会話・監査 | モデル・agent | イベントの削除・改変 | 追記専用、hash chain、外部アンカー |
| ホスト全体 | sandbox 脱出 | カーネル脆弱性、設定ミス | bwrap + seccomp + Landlock、fail closed |

**対象外**: マシンの root を奪取された後、Cloudflare アカウントの侵害、モデル提供者の侵害、物理アクセス。これらは hns の制御で閉じないので、鍵の失効とマシンの隔離で対応する（0165）。

## 2. hns の現在地

### 2.1 信頼境界

```text
Browser ── HTTPS/WS ─▶ Worker（認証・ルーティング）
                         └─▶ Session DO（pi-durable / モデル・ツール定義）
                                  └─ RPC ─▶ Workspace DO（版・lease・認可）
                                               └─ 署名付き HTTPS ─▶ Machine Agent（今は Node / TS）
                                                                      └─ bwrap ─▶ 実行
```

信頼する側: Worker / DO / Machine Agent。信頼しない側: モデルの出力、ツールが読むファイル・コマンド出力、workspace に置かれたコード。**モデルはツール定義を書き換えられない**が、bash を通せば任意のコードを実行できる。したがって境界は「モデル」ではなく「実行」。

### 2.2 既にある保証と穴

| 保証 | 機構 | 穴 |
| --- | --- | --- |
| exec は root の外に書けない | bwrap `--ro-bind / /` + root のみ `--bind` | 読み取りは広い。ネットワークは未分離（[sandbox-platforms.md](sandbox-platforms.md)） |
| sandbox がなければ exec を出さない | 起動時 probe、失敗なら bash 未登録 | 非 Linux は exec なし（意図どおり） |
| パス脱出・symlink | 正規化 + canonical 化 + dirfd helper | 親差し替えの TOCTOU 窓が残る（0054 / 0172） |
| 書き込みの直列化 | Workspace DO の lease + epoch + 再ハッシュ | ツール呼び出し自体の認可ではない |
| 冪等性 | operationId = callId 由来 | 引数の正規化・ハッシュ照合はない |
| 資格情報をモデルに見せない | provider 鍵は gateway、git/gh はマシン | `~/.config/hns` の hide が未配線（0052）。DEK 露出（XSS） |
| 拒否を値で返す | `{ok:false,status,message}` + isError | 拒否コードの語彙がツールごとにばらつく |
| 監査 | `tool.call` / `tool.result`（ツール名・ok・ms） | **引数・出力・決定 ID・ポリシー版が残らない**。ハッシュ連鎖もない |

不変条件（[ARCH.md](../../ARCH.md)）との対応: INV-01（Run は認可済み workspace に紐づく）、INV-02（Machine Agent が Root と権限を検証）、INV-03（版付き書き込み）、INV-13（lease は 1 台）。**ツール権限の INV がまだない**のが最大の欠落。

### 2.3 遅延の内訳

| 経路 | 実測 | 出所 |
| --- | --- | --- |
| 1 op（実デプロイ） | p50 28ms / p95 61ms | [RESULTS.md](../poc/cf-harness/RESULTS.md) |
| 1 turn 4 op | p50 181ms | 同上 |
| write | 平均 32ms | 同上 |
| bash | 平均 53ms | 同上（op 全体。ツール本体の内訳は未計測） |
| rooted helper probe | 77.7ms | [0191](../issues/0191-workspace-perf.md) |
| rooted helper write（hash+commit） | 154.6ms | 同上 |
| stdio MCP 1KB（参考） | 0.020ms | [benchivo](https://benchivo.com/developers/stdio-vs-http-latency/) |

read/write の 28〜32ms は cloudflared と DO の往復が支配的で、JSON の framing ではない。helper の 77〜154ms は **per-op のプロセス起動**が支配的。つまり hns の高速化は「プロセスを起こさない」「往復を減らす」の 2 点に集約できる。

### 2.4 欠けているもの（8 つ）

1. ツール権限の語彙（read_file のパス範囲、bash のコマンド分類、ネットワーク可否）。
2. ツールマニフェストのハッシュ固定と起動時照合（R1）。
3. 認可した呼び出しと実行の同一性（R2）。
4. 権限の grant と失効（R3）。lease は write だけで、ツール全体ではない。
5. 監査のハッシュ連鎖と外部退避（R4）。
6. egress の既定拒否（現状 bwrap はネットワークを切らない）。
7. 資格情報の受け渡し（git/gh をマシンに置いたまま、ツールから見える）。
8. 監査の材料（引数ハッシュ、決定 ID、ポリシー版）と改ざん検知。

## 3. OpenShell の構造化

### 3.1 全体像

| 構成要素 | 役割 | 信頼境界 |
| --- | --- | --- |
| Gateway | 認証、sandbox のライフサイクル、policy・provider・ログの配布 | 信頼する（control plane） |
| Compute driver | Docker / Podman / Kubernetes / VM で workload と supervisor を作り、境界を張る | 信頼するが判定はしない |
| Supervisor | policy 判定、資格情報の注入、DNS、上流接続、gateway との接続維持 | 信頼する（判定する側） |
| Sandbox runtime | agent を子プロセスとして所有し、exec・signal・loopback・ネットワーク仲介を行う | 信頼しない（agent と同じ側） |
| Agent | 任意のコード | 信頼しない |

重要なのは「sandbox は判定しない」。sandbox は「何をしようとしているか」を supervisor に渡し、supervisor が決める。hns は今、ツール権限の判定を DO が、パス封じ込めと実行を Machine Agent が持つ。**判定を Machine Agent の別プロセス（supervisor）に分けるかは要検証**だが、少なくとも「判定コード」と「実行コード」を分ける価値はある。

### 3.2 実行時の強制

| 層 | 機構 | 保証 | 限界 |
| --- | --- | --- | --- |
| ファイル | Landlock LSM。baseline は `hard_requirement` で ABI v3（Linux 6.2+）必須、`/.openshell` は baseline で保護。ポリシー側は既定 `best_effort` | パス単位の read/write。root 不要。symlink は `O_NOFOLLOW` + `fstat` で排除 | **ポリシー既定の `best_effort` は「FS 制限なしで続行」+ High 警告**。baseline は緩まないが、アプリ側の制限は落ち得る |
| プロセス | 非 root、capability なし、seccomp BPF の domain allowlist（AF_UNIX / AF_NETLINK(ROUTE) / AF_INET{,6}）と危険 syscall の EPERM | 特権昇格・危険 syscall の遮断 | seccomp はパスを見ない。`clone3` は引数を辿れず ENOSYS にして `clone` へ落とす（表現力の限界） |
| ネットワーク | seccomp user notification が socket/connect/bind/listen/sendto/sendmsg/setsockopt を捕捉し supervisor が判定。INET は ADDFD で loopback fd を注入（CONTINUE を使わない）。proxy は OPA/regorus で L4/L7 を評価 | 宛先・バイナリ・L7 で拒否。外側の network fence が backstop | **TOCTOU は単体で閉じない**（sibling-thread race をコードが明記）。L7 は 1 リクエストごとに OPA 評価 + TLS 2 回。L7 の既定は `audit` = **fail open** |
| 実行ファイル | `/proc` の実パス + 初回観測の SHA-256 を TOFU で pin、変更で拒否。認可は実パスと祖先に限り、コマンドラインのパスは診断情報 | パスの詐称・差し替えを防ぐ | TOFU。初回前に差し替えられると無力。パッケージ更新で正当に変わる |
| 起動 | supervisor の確認まで agent を起動しない。切断で凍結。Landlock/seccomp/通知/loopback/DNS を同じ runtime profile で実測し、不可なら fail closed | fail closed | 可用性とのトレードオフ |

### 3.3 ポリシー言語と評価

- **1 ファイル・version 1・厳格なパース**。未知フィールド、重複キー、`null` を拒否する。失敗は既定ポリシーに落ちず起動しない（[schema](https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema)）。
- **既定拒否**。network はルールがなければ全拒否。filesystem は作業ディレクトリ rw、`/bin`・`/usr`・`/lib`・`/etc` など ro。ネットワークを許すと baseline path を足す。
- **合成**: base policy（利用者） + provider のルール = effective policy。global policy があると base を置き換え、提案の承認も止める。
- **ルール意味論**: 複数一致は許可の和、deny は allow に優先、同じ host:port の設定は一致必須。監査モード（audit）と強制（enforce）を選べる。
- **静的と動的**: filesystem / Landlock / process は起動時固定。network / middleware は実行中に更新でき、**更新時に旧接続を閉じる**。読込失敗は既定で fail closed（`retain_last_valid` も選べる）。
- **版と検証**: 変更は gateway と sandbox の 2 回検証。revision を持ち、rollback は「古い revision を新しい revision として再提出」。
- **曖昧さの拒否**: 同じ host:port で `tls` / `allowed_ips` が食い違うポリシーは読み込み自体を拒否。filesystem の親子パス（`/tmp` と `/tmp/cache`）は prover では `unsupported`（symlink の可能性を推測しない）。
- **global は置換**: global policy は sandbox のポリシーを**制限追加ではなく置換**し、sandbox 側の変更と提案承認を止める。

hns への写像: YAML ではなく JSON/TypeScript でよいが、**厳格パース・既定拒否・静的分野と動的分野の分離・二重検証・旧接続/旧 grant の無効化**はそのまま採る。

### 3.4 ツール呼び出しの完全性（OpenShell の MCP 実装）

OpenShell は MCP を L7 で検査する。ここが「書き換えられないツール呼び出し」に最も近い。

- **ヘッダーと body の一致**: `Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version` が body の JSON-RPC と一致しなければ 400。重複ヘッダー、カンマ結合、`Connection` で指名されたヘッダーは拒否。base64 名は decode してから比較する（[mcp.rs](https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-supervisor-network/src/l7/mcp.rs)）。
- **版の allowlist**: endpoint ごとに許可する MCP revision を限定。未知の版は 403。
- **認可の単位**: method（`tools/call` など）と tool 名。**引数はまだモデル化していない**（ソースのコメントに明記）。つまり「どのツールか」は縛れるが「何を渡すか」は縛れない。
- **binary identity**: 接続元の実行ファイルを `/proc` から取り、初回の SHA-256 を pin。以後の変更は即拒否。パスは診断情報で、認可には使わない。

hns は MCP ではないが、**「ヘッダーと body の一致」=「認可した呼び出しと実行する呼び出しの一致」**として一般化できる。hns の方が有利な点は、ツールが型付き（valibot）なので**引数レベルまで縛れる**こと。OpenShell の空白を埋められる。

### 3.5 資格情報

- agent の env には**opaque な placeholder**（revision 付き）だけを渡す。実 credential は supervisor が、forward 直前に placeholder を置換して注入する。
- 解決には **3 つの境界すべて**が必要: (1) network policy が binary と宛先を許可、(2) credential binding が host/port/path を含む、(3) request 内の位置が宣言済みの header/query/path slot に一致。どれか欠けると `403 credential_endpoint_mismatch`。unknown/malformed/expired も fail closed。
- 動的 token grant（SPIFFE JWT-SVID の client_credentials / token_exchange）と refresh（OAuth2、Google SA、AWS STS）を持つ。refresh material は provider record と別に AES-256-GCM で保存。issuer はまだ internal refactoring 段階。
- TLS は sandbox→proxy を per-sandbox の一時 CA で終端（= MITM）、proxy→upstream は通常の TLS 検証。`tls: skip` は検査・置換・token grant をすべて諦める明示的な例外。
- 0.1.0 で managed inference route は削除され、モデル選択は workload 側に移った。OpenShell はモデルを選ばない。

hns への写像: provider 鍵は既に gateway にあり、マシンには無い。**「秘密は Worker に置き、マシンには短命 token だけ」**を採る。git/gh は GitHub App の installation token を Worker で mint し、repo / permission / TTL を限定するのが相当。TLS MITM は hns の経路（cloudflared + 各ツールが直接 TLS）と衝突するため採らない。bash に egress を許す場合だけ、`--unshare-net` + loopback proxy + placeholder 置換が条件になる。

### 3.6 変更管理

- **prover**: ポリシーと credential 集合と binary registry を Z3 の SMT モデルに符号化し、包含（boundary check）とリスク差分（proposal risk）を解く。boundary check は「candidate が許可し、boundary が許可しない action」の SAT を問い、UNSAT のときだけ `Within`。finding は 4 分類（link-local、L7 bypass、credential reach 拡大、method 拡大）。
- **証明の範囲**: filesystem / network_l4 / network_rest / process / landlock の 5 領域だけ。GraphQL / MCP / JSON-RPC / WebSocket、`tls: skip`、audit モード、host 省略、path の親子関係、UID の非 root 変更は `unsupported`。1,024 ルール / 4,096 endpoint 超は `inconclusive`。**`Within` だけが承認可**で、unsupported と inconclusive は承認に使わない。
- **証明しないもの**: 行為の意味的危険性、cross-sandbox の意図、実行時の proxy の挙動、credential の scope。accepted risks は finding の表示を変えるだけで、証明の前提を緩めない。
- **principal の分離**: sandbox は `policy.local` に**提案だけ**できる。`ApproveDraftChunk` は bearer + `config:write` + workspace admin を要求し、sandbox principal の method allowlist には入っていない。`UpdateConfig` も sandbox には「承認済みポリシーの同期」に限定され、filesystem / process / landlock は変更できない。
- **review token**: 提案時に「rule + 現行/候補の effective policy hash + credential fingerprint」の SHA-256 を作り、承認時に再評価して一致を要求する。承認直前の provider / policy 変更による誤承認（TOCTOU）を防ぐ。
- **advisor**: agent が拒否された通信に対して狭いルールを提案し、人が承認する。提案は add のみ、削除不可。auto は「prover の新規 finding なし」「危険先フラグなし」「global policy なし」のときだけ。global policy 中は承認不可。
- **monotonic confinement**: 提案は「狭める」か「広げる」かに分類され、広げるものだけ承認を要する（Progent と同じ思想、§6.5）。

hns への写像: 現時点のポリシー言語は小さいので Z3 は不要。**「能力集合の差分を計算し、拡大だけ人に出す」**を TypeScript で実装すれば足りる。ただし能力集合が育つ前提は置かず、集合包含で表せなくなったら Z3 / Cedar を CI に置く形で再評価する。OpenShell からは (a) 提案と承認を別 principal / 別 API に分ける、(b) review token で承認時の TOCTOU を閉じる、(c) 判定不能は deny、の 3 つをそのまま採る。D1 の CAS（`UPDATE ... WHERE revision = ?`）で承認と revision 更新を原子的にする。

### 3.7 拡張・観測・運用

- supervisor middleware は gRPC。policy 判定の後、credential 注入の前に走り、body の置換・safe header の追加削除ができる。credential header は見えないし変更できない。最大 10 stage、body 4 MiB、既定 fail closed。外部同期呼び出しなので hot path に載る。
- gateway interceptor は API 操作を `modify_operation` → `validate` → handler → `post_commit` で囲む。JSON Patch を返せるのは modify だけ。secret field は view から除外される。modify は「policy を広げる patch」も返せるため、gateway と同等の信頼が要る。
- extension 認証は gateway 署名の EdDSA JWT（`aud` / `caller_kind` / `sandbox_id`）。mTLS はなく、個別 revoke もできない。
- OCSF v1.8 の 8 クラス、JSONL / OTLP、denial の理由コード、policy_hash。ただし **best-effort** で、queue 満杯時は drop。**改ざん耐性・hash chain・署名はない**。
- CLI / TUI / SDK、Kubernetes（Helm、HA、CNI の NetworkPolicy 前提）、Docker/Podman/VM。stable は毎週火曜、N / N-1 を security サポート。
- Apache-2.0、Rust、v0.1.8（2026-11-10）。CNCF への移管中。公開された per-call 性能数値は見つからないが、seccomp のベンチハーネス（`seccomp-perf`）は同梱されている。

### 3.8 性能設計と未計測

- 1 本の HTTP/2 接続に control / DNS / TCP を多重化し、ストリームごとに backpressure を分ける。遅いダウンロードが DNS や exec を止めない。
- 小さなフレームのために TCP_NODELAY を既定で設定（loopback でも遅延 ACK を避ける）。
- policy 判定は supervisor のプロセス内（Rust）。namespace 越しの往復を避ける。
- **ただし速いわけではない**: 判定キャッシュはなく、L7 では 1 リクエストごとに OPA（regorus）を `Mutex` で直列評価する。上流接続のプールもなく、1 open = 1 dial。L7 は TLS を 2 回（sandbox→proxy、proxy→upstream）ハンドシェイクする。**この構成をそのまま hns に持ち込むと 28ms 予算に不利**。
- seccomp user notification のコストは LKML のマイクロベンチで sync 2,919ns / basic 8,655ns per syscall（peer-reviewed ではない）。1 回の判定には十分安いが、全 syscall の仲介は過剰。
- 起動はコンテナ/VM。Docker/Podman はネットワークを切り、Unix socket で supervisor と話す。
- **公開されている per-call 遅延はない**。hns は自前で測るしかない（§8）。

### 3.9 限界・成熟度

- v0.1.x（alpha 由来）。API と middleware 契約は変わる（docs が明記）。stable は毎週火曜。本番依存は時期尚早。
- **既知の CVE がある**: 2026-08 の NVIDIA bulletin で 0〜0.0.33 が影響、0.0.34 で修正。CVE-2026-65093（sandbox escape、9.9、探索パス）、CVE-2026-65083（9.9）、CVE-2026-65092（L7 REST の path traversal バイパス、8.5）、CVE-2026-65091（8.8）ほか。**強制機構そのものが攻撃面**であり、パス正規化を policy と実行で同一関数にすることが教訓。
- Linux は Landlock ABI v3（6.2+）と seccomp user notification が前提。macOS/Windows は別 backend（Windows native は loss を列挙）。
- prover はポリシーの部分集合しか扱わない。MCP/GraphQL は boundary check の対象外。
- TLS MITM は mTLS 上流・非 HTTP・独自 protocol を苦手とする。proxy は TLS を 2 回終端する。
- TOFU の binary pin は初回が弱い。パッケージ更新で正当に変わるたびに拒否される運用コストがある。
- Kubernetes は CNI の NetworkPolicy が前提。GPU と user namespace の併用は未検証。
- 監査は best-effort で、改ざん耐性を主張しない。

## 4. 要素分解と分類

判定: **採用** = 今の前提で採る。**不採用** = 今は採らない（前提が変われば再評価）。**要検証** = 小さく試してから決める。E45/E46 は後から追加した要素で、番号は追加順、表の並びは分類順。

### 4.1 信頼境界・制御

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E01 | 判定と実行の分離 | sandbox は判定せず supervisor が決める | Machine Agent が判定と実行を兼ねる | 採用 | 判定を関数として分離し、実行前に必ず通す。別プロセス化は E41 で判断 |
| E02 | 起動時 fail closed | supervisor の確認まで agent を起動しない。切断で凍結 | bwrap 不在で bash を出さない判断は既にある | 採用 | 既に近い。grant 検証失敗・ポリシー読込失敗も起動拒否に広げる |
| E03 | 短命 credential と generation 束縛 | TLS（サーバ認証）+ gateway 発行 JWT。JWT は sandbox と generation に束縛 | 0147 の Ed25519 署名はあるが generation 束縛が弱い | 採用（部分） | grant に epoch と期限を入れ、失効を 1 秒以内に |
| E04 | 単一・多重化チャネル | HTTP/2 + per-stream backpressure、TCP_NODELAY | per-op の HTTP 往復が 28ms の主因 | 採用 | cloudflared 上に persistent stream を 1 本。まず計測 |
| E05 | compute driver 抽象 | Docker/Podman/K8s/VM を差し替え | 実行基盤は Machine Agent 1 つ | 不採用 | 2 つ目の実装がない。抽象化は時期尚早（AGENTS.md の「2 呼び出し点」） |
| E06 | control plane が配布し local が強制 | gateway が policy を配り supervisor が強制 | DO が毎回認可する | 採用 | 署名付きポリシー束を配り、マシンがローカル判定（§7 Phase 1） |

### 4.2 実行隔離

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E07 | Landlock のパス規則 | ABI v3、read/write、`best_effort` | bwrap は read が広い。read 拒否を表現しにくい | 要検証 | bwrap 内で重ね、NixOS 6.18 で read 拒否・symlink・overhead を測る。壊れるなら不採用 |
| E08 | seccomp user notification | connect/sendto を supervisor に仲介 | per-syscall のネットワーク判定 | 不採用 | 今の要件では bwrap + proxy で足りる。broker はカーネル依存と TOCTOU が残る（言語は理由にしない） |
| E09 | 外側のネットワークフェンス | workload の net を切り supervisor のみ | bwrap はネットワークを切らない | 要検証 | `--unshare-net` + Unix socket proxy。DNS/TLS/git/npm の互換と p95 を測る |
| E10 | 非 root・capability なし | user namespace、cap drop、no_new_privs | bwrap の user namespace は使うが cap は明示的でない | 採用 | `--cap-drop ALL`、no_new_privs が立っていることの確認、uid/gid 固定を probe に含める |
| E11 | 実行ファイル identity と hash pin | `/proc` の実パス + TOFU SHA-256 | ツール実装・bash・helper の同一性 | 採用（TOFU は不採用） | 事前に観測したハッシュを台帳に置く。初回観測に依存しない。更新は明示操作 |
| E12 | プロセスの所有と signal/exec | agent を owned child にし、状態を保持 | bash の暴走・孤児 | 採用（概念） | 既に timeout/kill はある。プロセスグループと孤児回収を明示 |
| E13 | 保護パス | `/.openshell` を Landlock baseline で保護 | `~/.config/hns` が agent から見える（0052） | 採用 | hide を tmpfs で配線し、起動時に「読めない」ことを probe |

### 4.3 ポリシー

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E14 | 版付き・厳格スキーマ | version 1、未知フィールド/重複/null を拒否 | valibot は既定で余分なキーを落とす | 採用 | `strictObject` と版フィールド。未知は拒否 |
| E15 | 既定拒否と既定ポリシー | network 全拒否、fs は最小 baseline | bash は何でも実行できる | 採用 | profile の既定を「read-only + network なし」に。bwrap 不能なら exec なし |
| E16 | base/effective/global の合成 | provider ルールを足し、global は置換 | ポリシーの合成規則がない | 採用（部分） | まず base + capability grant。global は運用要件が出たら |
| E17 | allow の和・deny 優先・重複一致 | 複数一致は和、deny が勝つ、同一 endpoint は設定一致必須 | 規則が決まっていない | 採用 | 決定表を 1 箇所に。曖昧な重複は読込時に拒否 |
| E18 | audit / enforce | 既定 audit、強制は明示 | 拒否の観測がない | 採用 | まず audit で 1 週間観測し、enforce に上げる |
| E19 | 静的分野と動的分野 | fs/process は起動時固定、network は更新可 | ツール権限の変更粒度が未定 | 採用 | セッション開始時に tool set / fs / network profile を固定。grant だけ動的 |
| E20 | revision・二重検証・rollback | gateway と sandbox が各々検証 | ポリシーの版がない | 採用 | DO が revision を持ち、マシンが再検証。不正は起動拒否 |
| E21 | hot reload と旧接続の無効化 | 変更時に既存接続を閉じる。失敗は fail closed | grant の失効が即時に効かない | 採用 | epoch bump + 期限。失効時は既存 grant を無効化し、次 call で拒否 |

### 4.4 ツール完全性

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E22 | 認可した呼び出しと実行の一致 | MCP ヘッダー/body 一致、重複・hop-by-hop 拒否 | 認可後の引数改変・正規化ズレ | 採用 | 正規化 JSON（JCS）+ SHA-256。判定・実行の両方で再計算 |
| E23 | ツール名/method の認可 | method + tool 名 | ツール権限の語彙がない | 採用 | `(toolId, version)` を grant の最小単位に |
| E24 | 引数レベルの制約 | **未実装**（引数はモデル化しない） | path/command/network の範囲 | 要検証 | hns は型付きなので可能。valibot + パス正規化 + コマンド分類を試作 |
| E25 | ツール版の allowlist | MCP revision の allowlist | ツール実装の更新で意味が変わる | 採用 | manifestHash と toolVersion を grant に含める |
| E26 | middleware の順序と fail closed | policy 後・credential 前。失敗は遮断 | 呼び出しの書き換えは R2（同一性）と衝突 | 不採用（v1） | 書換は認可の同一性を壊す。必要なら「監査のみ」から |

### 4.5 資格情報

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E27 | placeholder と境界注入 | agent に実 credential を渡さない | git/gh がマシンにあり、bash から見える | 採用 | 少なくとも provider 鍵はマシンに置かない（既に達成）。git/gh は範囲を限定 |
| E28 | provider profile / endpoint binding | credential の行き先を束縛 | ツールごとの資格情報の範囲がない | 要検証 | git/gh の UX と SSH 鍵の扱いを試作。壊すなら保留 |
| E29 | TLS MITM と per-sandbox CA | L7 検査・注入の前提。sandbox→proxy は一時 CA、proxy→upstream は通常の TLS 検証 | hns のツールは直接 TLS | 不採用 | CA 配布・mTLS・非 HTTP の破壊が大きい。L7 1 リクエストごとに TLS 2 回。必要になるまで採らない |

### 4.6 変更管理

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E30 | SMT による包含・差分検証 | Z3、boundary/proposal risk、coverage 明示 | 権限拡大のレビューが人力 | 要検証（Z3 は不採用） | 現時点は能力集合の差分を TS で計算。能力が育ったら Z3 / Cedar を CI に |
| E31 | 未対応・不能を失敗にする | `unsupported`/`inconclusive` は失敗 | 検証の穴を黙って通す危険 | 採用 | coverage を結果に含め、未知は deny |
| E32 | agent 提案 + 人承認 | advisor、auto は限定 | 権限拡大の UX がない | 採用 | 提案はデータ。適用は人。auto は当面なし |
| E33 | 単調な権限（拡大だけ承認） | 狭める変更は自動、広げる変更は承認 | grant の更新規則 | 採用 | Progent と同じ。拡大の判定を 1 関数に |
| E34 | global policy / accepted risks | 全体上書き、受容リスクの記録 | 例外の管理 | 採用（後） | 例外は owner と期限付きで。まずは不要 |
| E45 | 承認の鮮度と principal 分離 | review token（現行 policy hash + 候補 + credential fingerprint）、承認は bearer + config:write + admin、sandbox は提案のみ | 承認時の TOCTOU と自己承認 | 採用 | D1 の CAS で「承認 + revision 更新 + audit」を原子に。agent の tool token では承認 API を呼べない |

### 4.7 拡張・観測

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E35 | middleware / interceptor | gRPC で検査・書換 | 拡張点がない | 不採用 | 書換は R2（同一性）を壊し、攻撃面も増える。監査フックだけなら将来 |
| E36 | 構造化された denial イベント | OCSF、理由コード、policy hash | 拒否の語彙がばらつく | 採用（最小） | OCSF 全文は不要。`{code, tool, path?, policyRev, grantId}` を固定 |
| E37 | OTel traces | 分散トレース | hop ごとの遅延が見えない | 要検証 | tool call の span を試作。DO の CPU 予算と相談 |
| E38 | CLI / TUI / SDK | 操作面 | 製品面は Web | 不採用 | hns は Web GUI。CLI は Machine Agent の運用に限定 |
| E46 | 改ざん検知できる監査 | **未実装**（OCSF は best-effort、hash chain なし） | 監査の完全性（R4） | 要検証 | 引数ハッシュ + 前ハッシュ + 外部アンカー。Cloudflare R2 の immutability とコストを測る |

### 4.8 配備・性能

| ID | 要素 | OpenShell の機構 | hns の課題 | 判定 | 条件・理由 |
| --- | --- | --- | --- | --- | --- |
| E39 | Kubernetes / HA / Helm | control plane の配備 | hns は Cloudflare + 各マシン | 不採用 | 前提が違う。単一マシン構成を強みにする |
| E40 | 配布・供給網 | 署名付き release、checksum、SBOM、image 検証 | Machine Agent の配布（0040） | 採用 | 署名・checksum・SBOM を配布物に。nix / 単体バイナリ / npm |
| E41 | プロセス内のポリシー判定 | Rust の supervisor 内 | DO 往復 28ms | 採用 | マシン内の純関数として判定。grant 検証は Ed25519 + ローカル |
| E42 | seccomp-notify の性能 | ptrace より速い | — | 不採用 | E08 を採らないため。BPF の seccomp は採る |
| E43 | 再起動なしの反映 | hot reload | ポリシー変更に再起動が要る | 採用 | grant と egress は反映。fs はセッション再作成 |
| E44 | コンテナ/VM を既定に | 強い隔離 | bwrap で足りるか | 不採用 | 起動 0.1〜7s。bwrap + seccomp で足りる範囲を先に測る |

## 5. 分類の理由（要点）

### 5.1 採用の中心: capability lease と canonical call

**問題**: per-call の DO 認可は安全だが 28ms かかる。権限を毎回 DO に聞かずに、かつエージェントが権限を広げられないようにするには、**期限付き・範囲付き・署名付きの grant** を事前に発行し、マシンがローカルで照合するのが最小の解。hns の write lease（INV-13）と同じ形を、ツール全体に広げる。

**grant の形（案）**:

```text
{
  v: 1,
  grantId, sessionId, workspaceId, machineId,
  toolId, toolVersion, manifestHash,
  scope: { pathPrefixes?, commandClasses?, hosts?, maxCalls, maxBytes },
  issuedAt, expiresAt, epoch,
  issuerKeyId
} + Ed25519 signature
```

**検証（マシン、per call）**:

1. 署名（Ed25519）と issuer の pin。
2. `epoch` が Workspace DO の現在値と一致（失効していない）。
3. `expiresAt` が未来。時計ズレは許容幅を固定。
4. `toolId/version/manifestHash` が実行するツールと一致（R1）。
5. 正規化した引数のハッシュが grant の scope に含まれる（R2）。
6. `maxCalls` / `maxBytes` の残量。消費はアトミックに。
7. 拒否は typed denial（`grant_expired` / `scope_exceeded` / `manifest_mismatch` / `epoch_stale`）。

**速度**: 署名検証は Node の crypto で 0.1ms 級（要測定）。DO 往復が消えるので L1/L2 が改善。失効は epoch bump + 短い TTL（30〜60 秒）で、最悪 TTL 分の遅れ。**「即時失効」が必要なら、マシンへの制御ストリームで epoch を push する**（E04 の persistent stream と相乗り）。

**注意**: grant は「権限の拡大を防ぐ」が「権限の誤用を防ぐ」わけではない。モデルが grant の範囲内で意図しない操作をする攻撃（confused deputy）は、引数レベルの制約（E24）と監査でしか減らない。

**grant を誰が発行・拡大できるか**も同じくらい重要。agent の tool token では grant の発行・拡大・承認を呼べないようにし、人間のセッション（owner/admin）だけが呼べる別 API にする。提案には review token（現行ポリシーの hash + 候補 + 資格情報の fingerprint）を付け、承認時に再計算して一致を要求する。これで「承認したつもりの内容と、実際に適用される内容」のズレ（TOCTOU）を閉じる。D1 の CAS で承認と revision 更新を原子的にする。

### 5.2 不採用の理由と再評価条件

この節の不採用は [D079](../../docs/decisions/D079.md) で決定した。行は要素と 1:1 ではない。E30 と E11 は要素としては「要検証」「採用」だが、不採用にした方式（Z3 実装 / TOFU）をここに挙げる。

| 不採用 | 理由 | 再評価する条件 |
| --- | --- | --- |
| E05 driver 抽象 | 実装が 1 つしかない | macOS/Windows backend を実装するとき |
| E08 seccomp-notify | 今の要件では bwrap + proxy で足りる。broker の複雑さと TOCTOU が残る | per-syscall のネットワーク判定が要件になったとき |
| E26 middleware 書換 | 認可した呼び出しの同一性（R2）を壊す | 「監査のみ」のフックなら可 |
| E29 TLS MITM | CA 配布・mTLS・非 HTTP の破壊。hns の利点（鍵がマシンにない）と重複 | サードパーティ API の L7 制御が製品要件になったとき |
| E30 の Z3 実装 | 現時点ではポリシー言語が小さく、TS の差分計算で足りる | ポリシーが cross-product を持つ／監査要件が厳しくなったとき |
| E35 拡張点 | 書換は呼び出しの同一性を壊し、攻撃面も増える | 顧客ごとの検査要件が出たとき |
| E38 CLI/TUI | 製品面は Web | 運用者向け CLI が必要になったとき |
| E39 K8s | 配備モデルが違う | セルフホストを k8s で提供するとき |
| E42 seccomp-notify 性能 | E08 を採らない | E08 を採るとき |
| E11 の TOFU 方式 | 初回観測前に差し替えられると無力。更新のたびに誤拒否 | 事前ハッシュを配れない配布形態のとき |
| E44 VM 既定 | 起動コスト。bwrap + seccomp で足りる | マルチテナント／信頼できないコードを同居させるとき |

#### 5.2.1 seccomp user notification によるネットワーク仲介を採らない理由

**何を解くか**: 任意のプロセスの `connect` / `sendto` / `socket` をカーネルで止め、supervisor が「どのバイナリが、どの宛先へ」を判定する。環境変数の proxy を無視するプログラムでも迂回できない。

**魅力的な点**: 宛先の判定をプログラムの協力なしに強制できる。OpenShell はこれで「全 egress を supervisor 経由」にし、バイナリ identity と L7 を組み合わせている。

**採らない理由**:

1. **言語は理由にしない**。Machine Agent は今 TS だが、仕様とテストが固まれば Rust / Zig / C への刷新は選択肢である。seccomp broker を採らないのは、broker が `SECCOMP_IOCTL_NOTIF_RECV/SEND/ADDFD`、`process_vm_readv`、pidfd、BPF 生成というカーネル ABI と TOCTOU の複雑さを抱え、正しさのテストが重いから。言語を変えてもこの複雑さは消えない。
2. **同じ保証を既存の部品で得られる**。`bwrap --unshare-net` でネットワークを切り、loopback の proxy socket だけを見せれば、プログラムは proxy 以外に出られない。mount/net namespace は既に使っており、新しい特権コードを足さない。
3. **per-syscall のコストと複雑さ**。LKML のマイクロベンチで sync 2,919ns / basic 8,655ns per syscall（peer-reviewed ではない）。これはトラップだけで、/proc の identity 解決・判定・fd 注入は別。`bash` のビルドや test は何万 syscall も出す。
4. **それ単体では閉じない**。OpenShell のコード自身が「seccomp CONTINUE に固有の sibling-thread pointer race」を認め、外側の network fence を backstop にしている。つまり fence はどのみち必要で、seccomp-notify の上乗せは限定的。
5. **強制機構は攻撃面**。OpenShell は 2026-08 に sandbox escape 9.9（CVE-2026-65093）と L7 path traversal 8.5（CVE-2026-65092）を修正している。自前のカーネル境界を増やすほど、hns が守るべきコードも増える。
6. **hns の粒度に合わない**。hns が決めたいのは「このツールがこの host:port に出てよいか」であり、任意バイナリの syscall 単位の意図ではない。`bash` は opaque なので、syscall を見てもコマンドの意味は分からない。

**代わりに採る**: `--unshare-net` + UDS proxy（E09）、危険 syscall の BPF 遮断（E42 / S7）、ツール境界での capability 判定（E24 / E41）。

**再評価する条件**: サードパーティ製の任意バイナリに per-binary のネットワークポリシーを課す必要が出たとき、proxy を強制できない経路（raw socket、netlink、継承 fd）が実測で見つかったとき、Machine Agent に別目的の Rust helper が入るとき、マルチテナントのマシンでプロセス単位の分離が要るとき。

#### 5.2.2 TLS MITM による資格情報注入を採らない理由

**何を解くか**: per-sandbox の一時 CA で TLS を終端し、L7 を検査し、placeholder を実 credential に置換して上流へ再接続する。agent に実鍵を渡さず、承認済み endpoint にだけ credential を付ける。

**魅力的な点**: 鍵が sandbox に入らない。REST の method/path、MCP の tool 名までネットワーク層で縛れる。

**採らない理由**:

1. **hns には守るべき provider 鍵がマシンに無い**。provider 鍵は gateway Worker にあり、マシンには置かない（D047 / 0143）。git/gh は利用者自身の開発環境の資格情報としてマシンに残す設計。MITM は「sandbox に実鍵がある」前提の解決策で、hns の現状には当てはまらない。
2. **CA 配布と互換性のコストが大きい**。Node、Python、curl、git、Go、Rust、Java の trust store に CA を入れ、証明書 pinning、mTLS 上流、HTTP/2・HTTP/3、WebSocket、非 HTTP を扱う必要がある。OpenShell 自身が `tls: skip`、raw TCP、h2c、SQL passthrough、圧縮応答を例外として列挙している。例外は穴か互換性破壊のどちらかになる。
3. **遅延が増える**。L7 では 1 リクエストごとに TLS を 2 回（sandbox→proxy、proxy→upstream）ハンドシェイクし、OPA を毎回評価する。OpenShell の proxy には判定キャッシュも上流プールもない（1 open = 1 dial）。`git clone` や `npm install` ではリクエスト数が多く、28ms/op の予算に不利。
4. **信頼境界が増える**。proxy は平文の credential と全 traffic を見る trusted component になる。CA 秘密鍵は高価値資産で、配布・ローテーション・漏えい時の影響が大きい。hns が新たに保守するコードが増える。
5. **ツール境界で代替できる**。hns のツールはサーバ側の型付き関数なので、`github_api` のような専用ツールを Worker で実行し、そこで短命 token を付ければよい。任意バイナリに credentialed API を叩かせる要件が出るまで、MITM は不要。

**代わりに採る**: 秘密は Worker に置き、GitHub App の installation token などを短命・狭 scope で mint する（E27 / E28）。`bash` に egress を許す場合も、まずは CONNECT の host:port allowlist（復号しない）で足りるか測る（E09）。

**再評価する条件**: サーバ側ツールではなく任意のユーザーコードが credentialed API を呼ぶ必要が出たとき、bash の egress に method/path の L7 制御が製品要件になったとき、Cloudflare 側の managed proxy で CA 運用なしに同等のことができると分かったとき。

#### 5.2.3 Z3 による形式検証を採らない理由

**何を解くか**: ポリシー・credential 集合・binary registry を SMT に符号化し、「candidate が boundary を超える具体例が存在しない」こと（UNSAT）を証明する。提案の差分リスクも 4 分類で検査する。

**魅力的な点**: 人間が組合せを数え上げなくても、credential × binary × host × method の相互作用を反例付きで示せる。

**採らない理由**:

1. **現時点の能力集合は小さい**。ツールは `read_file` / `write_file` / `bash` の 3 つで、能力は `(tool, path prefix, host, port, method, command class)` のタプルに正規化できる。包含判定は集合差で正確に決まり、今は Z3 を持ち込む理由がない。**ただし将来も小さい保証はない**。能力が cross-product や条件属性を持つようになったら、この判断は再評価する（末尾の条件）。
2. **prover の保証は見た目より狭い**。OpenShell の boundary check は filesystem / network_l4 / network_rest / process / landlock の 5 領域だけで、GraphQL / MCP / JSON-RPC / WebSocket、`tls: skip`、audit モード、path の親子関係、UID 変更は `unsupported`。1,024 ルール / 4,096 endpoint 超は `inconclusive`。証明するのは「書かれたポリシー」であり、実行時の挙動でも意図でもない。
3. **bash は証明できない**。何を実行するか分からないコマンドの安全性は SMT では出せない。hns で証明できるのは「bwrap の封筒」と「egress allowlist」だけ。これは集合包含で足りる。
4. **実行時には置かない**。Z3 を Workers/DO の CPU とバンドルに載せるのは現実的でなく、CI か別サービスになる。デプロイと障害点が増える。Cedar の SMT 分析でも平均 75.1ms、Zelkova は 99% を 160ms 未満で解くが、いずれもオフライン前提の数字。
5. **モデルと実装の乖離が新しいリスクになる**。SMT の意味論が実行時とずれると、証明済みなのに抜ける。現時点の小さな型付き言語を同じ型で total に実装する方が、hns の規模では sound に保ちやすい。

**代わりに採る**: 現時点は能力集合の差分検証を TypeScript で行い、拡大だけ人承認にする（E30 / E33 / S10）。未対応は deny（E31）。検証は CI / ポリシー公開時だけに置く。能力が育ったら、同じ場所に Z3 / Cedar を差し込む。

**再評価する条件**: ポリシーが cross-product や条件属性（時刻・ラベル・委譲連鎖）を持ち、集合包含で表せなくなったとき。大規模ポリシーの等価性・包含を監査証跡として求められたとき。マルチテナントの RBAC/ABAC が複雑化したとき。その場合も実行時ではなく CI に置く。

#### 5.2.4 Kubernetes / マルチランタイム対応を採らない理由

**何を解くか**: Docker / Podman / Kubernetes / VM を同じ policy で扱い、gateway を HA にする。強い隔離（gVisor / Kata / microVM）を runtime として選べる。

**魅力的な点**: 配備の柔軟性、スケール、既存クラスタへの統合、隔離の強化。

**採らない理由**:

1. **hns の配備モデルと違う**。hns は Cloudflare Worker/DO + 各マシンの Machine Agent（D047）。Cloudflare はワークロードを実行せず、マシンは個人の開発機で cloudflared の外向き接続だけを持つ。K8s はクラスタの control plane であり、hns にはクラスタが無い。K8s 対応は機能追加ではなく別プロダクトになる。
2. **単一 runtime は強み**。Linux + bwrap の 1 経路に絞り、使えなければ fail closed（D032）。driver 抽象は 2 つの実装が揃ってから作るのが hns の規律（AGENTS.md の「2 呼び出し点」）。今は 1 つしかない。
3. **境界の組合せが爆発する**。Docker の network=none、K8s の CNI NetworkPolicy、VM の vsock、Windows の MXC で、policy の意味論が揃わない。OpenShell 自身が MXC の policy mapper loss を列挙し、K8s は CNI の NetworkPolicy を前提にしている。hns が同じテスト matrix を持つ理由がない。
4. **運用コスト**。HA gateway + PostgreSQL + Helm + CNI + イメージ配布は、DO/D1/R2 のマネージド構成と比べて重い。hns の差別化は「UI とサーバを自前で動かし、実行は手元に残す」ことで、K8s はそこに寄与しない。
5. **隔離の強化は別の手段で足りる**。まず bwrap + seccomp + Landlock の追加硬化を測る（S1 / S7）。それで足りないマルチテナント要件が出たら、そのときに 2 つ目の runtime を足す。

**代わりに採る**: 1 runtime（bwrap）を厳格な probe で固定し、セッション単位で再利用する。配布は nix / 単体バイナリ / npm（0040）。観測は hop ごとに取る。

**再評価する条件**: 顧客の K8s 上で hns を提供する要件が出たとき。共有マシンでマルチテナント実行が必要になったとき。macOS / Windows 対応で 2 つ目の backend が必要になったとき（0006 / 0033 / 0040）。VM 級の隔離が顧客要件になったとき。

#### 5.2.5 middleware による呼び出し書き換えを採らない理由

**何を解くか**: policy 判定の後、credential 注入の前に、HTTP の body/header を検査・置換する。redaction、content guard、プロトコル正規化を agent のコード変更なしに差し込む。

**魅力的な点**: 拡張性が高い。顧客ごとの検査や変換を、コアを変えずに足せる。

**採らない理由**:

1. **R2（呼び出しの同一性）を壊す**。hns の約束は「認可した呼び出しと実行する呼び出しが同一」。認可後に body/引数を書き換えられると、callHash も grant も無効になる。OpenShell はネットワーク層で「policy → middleware → credential → upstream」の順に判定するので成立するが、hns はツール境界で実行前に認可する。書き換えるなら再認可が必要で、遅延と複雑さが戻る。
2. **hot path に新しい trusted component が入る**。middleware は平文の引数・結果を見て変更できる。バグや悪意ある plugin は、そのまま改ざん・持ち出しになる。OpenShell の middleware も sandbox されず、operator の信頼責任と明記されている。hns が同じものを持つなら、署名・版・失敗隔離・監査が要る。
3. **遅延**。OpenShell の middleware は外部 gRPC 呼び出しで、既定 fail closed、最大 10 stage、body 4 MiB。28ms/op の hot path に同期で置くのは過剰。
4. **欲しい効果は in-process で足りる**。redaction、出力上限、パス正規化、危険コマンドの拒否は、ツール実行器の固定 pipeline（normalize → authorize → execute → redact → audit）で実装できる。汎用 plugin API は要らない。
5. **拡張点を絞る方が安全**。変換は認可の前（canonical call を作る時点）に限定し、認可後は変えない。外部拡張は非同期の監査・enrichment だけにする。

**代わりに採る**: 固定の in-process pipeline。認可後の書き換えを禁止し、どうしても必要な変換は canonical call の一部としてハッシュ前に適用する（E22 / E36）。

**再評価する条件**: 顧客が in-process で実装できない DLP / content inspection を要求したとき。サードパーティのツールサービスに署名・変換が必要になったとき。MCP サーバの応答正規化が必要になったとき。その場合も、署名付き manifest・allowlist・fail closed・変換後の再認可を持つ狭いフックに限定する。

### 5.3 要検証と採用前の確認（§8 のスパイクへ）

1. **E07 Landlock**（S1）: bwrap 内で read 拒否が表現できるか。ABI、symlink、overhead。
2. **E09 egress fence**（S2）: `--unshare-net` + UDS proxy で git/npm/curl が通るか。p95。
3. **E24 引数制約**（S5）: パス・コマンド・ホストの制約を valibot + 正規化で書けるか。迂回（symlink、`..`、shell metachar）を落とせるか。
4. **E28 資格情報**（S9）: git/gh の UX を壊さずにスコープを絞れるか。
5. **E30 差分検証**（S10）: 能力集合の拡大を TS で漏れなく分類できるか。
6. **E37 トレース**（S12）: DO の CPU 予算内で span を出せるか。
7. **E46 監査**（S8）: hash chain + 外部アンカーで改ざんを検知できるか。追加コストと保持期間。
8. **E45 承認**（S11、採用だが確認が必要）: agent の token で承認 API を呼べないこと、review token の再計算が競合時にも正しいこと。

## 6. OpenShell 以外の既製品・研究

### 6.1 コーディングエージェント

| 製品 | 機構 | hns への学び | 判定 |
| --- | --- | --- | --- |
| Claude Code | Linux は bwrap + socat proxy、macOS は Seatbelt。許可ドメインは空から。書き込みは作業ディレクトリ、**読み取りはマシンのほぼ全体**。file ツール・MCP・hooks は sandbox の外 | 「per-command 境界」と「プロセス全体境界」を分ける。hns は全ツールがサーバ側なので後者に近い。proxy allowlist と denyRead の設計を採る | 設計採用 |
| Codex CLI | **bwrap 既定 + プロセス内 seccomp**（no_new_privs、io_uring 全遮断、FS 制限時 AF_VSOCK 遮断）。network 既定 off。Landlock は legacy。exec-server は JSON-RPC + capability token | hns の bwrap に seccomp を足す。常駐 exec サーバと token 検査。permission profile をデータ化 | 採用 |
| Gemini CLI | Seatbelt / Docker / gVisor / LXC を選択。既定プロファイルは network 許可 | 「方式選択 + 安全側既定」の UX。既定 network 許可は採らない | 参考 |
| Copilot cloud sandbox | ホステッド Linux、開始後は環境不変、firewall allowlist | セッション開始時に環境を固定する思想 | 思想のみ |

**重要な事実のずれ**: Codex の Linux 隔離は、2025 年の二次情報では「Landlock + seccomp」と書かれるが、2026-11 の一次コードは **bwrap 既定 + Landlock legacy**。二次情報をそのまま設計根拠にしない。

### 6.2 実行環境

| 機構 | 隔離 | 起動・遅延 | hns 適合 |
| --- | --- | --- | --- |
| bwrap | mount/user namespace。root 不要 | プロセス起動のみ | **本線**。seccomp と Landlock を足す |
| Landlock | 非特権のパス制御 | syscall コストのみ | 読み取り拒否の補完（要検証） |
| seccomp BPF | syscall フィルタ | ほぼゼロ | io_uring / AF_VSOCK の遮断（採用） |
| Firecracker / E2B | microVM | VMM 6〜60ms、環境は 0.1〜秒 | ゲスト配布の運用が重い。不採用 |
| gVisor | ユーザ空間 kernel | 起動 0.33s（二次）、netstack 分離 | cloudflared と衝突。不採用 |
| Kata | HW 隔離 VM | 6〜7s | 予算外 |
| Wasmtime/WASI | capability | instantiate は µs〜ms | bash 不可。純関数ツール限定なら将来 |
| nsjail | namespaces + seccomp | spawn 数 ms | bwrap と重複 |
| microsandbox | ローカル microVM | 未公開 | bwrap 不能ホストの fallback（要検証） |

### 6.3 ポリシー・認可

| 機構 | 学び | 判定 |
| --- | --- | --- |
| OPA/Rego | linear fragment はほぼ定数時間、1ms 予算。Wasm にできる | 要検証（DO/Worker に載るか） |
| Cedar | Rust + Lean 検証。ルールの静的解析 | 要検証（認可の語彙が hns と違う） |
| OpenFGA | 関係性認可。ネットワーク越しの Check は 1 op 予算に不合 | 不採用 |
| SPIFFE/SPIRE | workload identity。cloudflared と重複 | 不採用 |
| eBPF LSM / Tetragon | カーネル内強制。権限・カーネル差が重い | 不採用 |
| MCP annotations | **hint であり強制ではない**。仕様が untrusted サーバの値で判断するなと明記 | 表示・承認の補助のみ |

### 6.4 MCP とツール供給の完全性

- MCP の authorization は OPTIONAL。stdio は環境変数の資格情報。ToolAnnotations は hint。
- tool poisoning（説明文への指示埋め込み）と rug pull（承認後の定義差し替え）は仕様の security best practices に記述がない（2026-11 時点）。
- Docker MCP Gateway は「有効化した MCP サーバのコードは malicious であり得る」と明示し、catalog / label / README をデータとして扱い、権限拡大に使わせない。
- hns はサーバ側 defineTool なので tool poisoning は構造的に起きにくい。残るのは (a) ツール**出力**経由の注入、(b) 将来 MCP クライアントになる場合の rug pull。

### 6.5 論文・研究

数字は abstract と調査ノート（ローカル、リポジトリ外）から。2026 年の preprint は「preprint」と付ける。

| 研究 | 主張 | 実証の数字・限界 | hns への含意 |
| --- | --- | --- | --- |
| [AgentDojo](https://arxiv.org/abs/2406.13352) | ツール実行エージェントの動的ベンチ（97 タスク / 629 ケース） | 攻撃なしでも 66% 未満しか解けない。最良でも ASR 25% 未満、検出器で 8%。能力の高いモデルほど攻撃されやすい | 受け入れ試験に使う。bash 向けケースを足す |
| [CaMeL](https://arxiv.org/abs/2503.18813) | 信頼済みクエリから制御/データフローを抽出し、capability で exfil を防ぐ | AgentDojo で 77% を証明可能な安全性付きで解決（無防御 84%）。v1 は 67%。ポリシー記述・de-classification・side channel が未解決 | planner/executor 分離は v0 では過大。**能力トークンの部分だけ先に採る** |
| [Progent](https://arxiv.org/abs/2504.11703) | ツール名 + 引数のシンボリック規則を毎 call 決定論的に検査。**narrowing は自動、expansion は承認** | 手書きポリシーで ASR 0%。LLM 生成で 39.9%→1.0%、utility 76.3%（元 79.4%） | **hns の設計に最も近い**。§5.1 の grant と §7 の差分検証の根拠 |
| [AgentArmor](https://arxiv.org/abs/2508.01249) | 実行トレースを CFG/DFG/PDG 化し型システムで検査 | AgentDojo で ASR 3%、utility 低下 1% | 引数に untrusted マーカーが付いたら write/外部送信を拒否する簡易版が現実的 |
| [AgentSpec](https://arxiv.org/abs/2503.18666) | trigger / predicate / enforce の軽量 DSL | コードエージェントの 90% 超で不安全実行を防止、ms 級オーバーヘッド。規則の網羅性に依存 | ポリシー DSL の出発点。**評価と強制を別プロセスに分ける** |
| [ShieldAgent](https://arxiv.org/abs/2503.22738) | ポリシー文書から規則を抽出し LLM 推論で軌跡を監視 | 平均 +11.3%、recall 90.1%、API 64.7% 削減。ただし確率的 | 非同期の事後監査向き。単独防御にしない |
| [ToolEmu](https://arxiv.org/abs/2309.15817) | LM でツール実行をエミュレートして危険を試験 | 同定した失敗の 68.8% が実世界でも妥当。最安全でも 23.9% 失敗 | bash の危険ケース拡張に使う。bwrap 脱出は実機 red team が必要 |
| [MCP 記述子攻撃](https://arxiv.org/abs/2512.06556) / [ETDI](https://arxiv.org/abs/2506.01333) | Tool Poisoning / Shadowing / Rug Pull。ETDI は署名・不変版・OAuth・ポリシー | 記述子操作で最大 36% の不安全呼び出し。多層防御で 15%、block 74%（preprint）。ETDI は設計提案で定量評価なし | 承認を**ツール定義のハッシュ**に結び付ける。名前や説明文だけで承認しない |
| [Capsicum](https://www.usenix.org/conference/usenixsecurity10/capsicum-practical-capabilities-unix) / [WASI](https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md) | fd / handle ベースの能力。ambient authority を落とす | cap_new は dup より 50.7% 遅い（539ns）。gzip は定常 2.4ms。capability-aware syscall は数 % 遅い | 「パス文字列」ではなく「開いた root へのハンドル/トークン」を渡す設計の根拠 |
| [Zelkova](https://d1.awsstatic.com/Security/pdfs/Semantic_Based_Automated_Reasoning_for_AWS_Access_Policies_Using_SMT.pdf) / [Cedar](https://arxiv.org/abs/2403.04651) | ポリシーを SMT で形式化し包含・境界を検証 | Zelkova: 99% を 160ms 未満、PSPACE-complete、sound。Cedar: OpenFGA より 28.7–35.2 倍、Rego より 42.8–80.8 倍高速、SMT 平均 75.1ms | **CI / 公開時のみ**。DO のリクエストパスで SMT を回さない |
| [gVisor](https://www.usenix.org/conference/hotcloud19/presentation/young) / [Firecracker](https://www.usenix.org/conference/nsdi20/presentation/agache) / [Landlock](https://doi.org/10.1109/ISDFS69419.2026.11459106) / [seccomp](https://lists.openwall.net/linux-kernel/2023/03/08/249) | 隔離の強度とコスト | gVisor: syscall 2.2 倍、外部 tmpfs の open/close 216 倍、小ファイル読取 11 倍。Firecracker: VMM 8 CPU ms、メモリ <5MiB、起動 125ms は vendor claim。Landlock: 無視できる overhead、事前 fd と非ファイルは対象外。seccomp notify: 2,919ns/syscall | per-call の gVisor/microVM は不採用。bwrap + Landlock/seccomp の追加硬化を検証 |
| [LLMCompiler](https://arxiv.org/abs/2312.04511) / [PASTE](https://arxiv.org/abs/2603.18897) / [Agentic Plan Caching](https://arxiv.org/abs/2506.14852) | 並列・投機・キャッシュで latency を削る | LLMCompiler: 最大 3.7 倍、コスト 6.7 倍、精度 +9%。PASTE: タスク完了時間 43.5% 削減、tool latency 1.8 倍。APC: コスト 50.31%、latency 27.28% 削減 | **read_file のみ**投機・並列・キャッシュ。write/bash は直列 + 承認 |
| [SPORK](https://arxiv.org/abs/2607.03333) / [ToolSpec](https://aclanthology.org/2026.emnlp-main.409/) / [FANTASE](https://aclanthology.org/2024.findings-emnlp.359/) | 投機的ツール実行と制約付きデコーディング | SPORK: GAIA P95 を 18% 削減（131.9→108.1s）。ToolSpec: 最大 4.2 倍。FANTASE: スキーマへの faithfulness を保証するが「安全」は保証しない | 投機結果は確定まで隔離。スキーマ検証はサーバ側で必ず行う |
| [CIBA](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0-final.html) / [Auditable Agents](https://arxiv.org/abs/2604.05485) / [NovaFabric](https://arxiv.org/abs/2609.12582) | 分離承認と tamper-evident 監査 | CIBA: binding_message で取引内容を提示。Auditable: 実行前仲介 8.3ms、617 所見。NovaFabric: DSSE/RFC3161/Merkle、10M edge で p99 45.5ms、replay 検知は 2/10 で不十分（preprint） | 権限拡大だけ CIBA 風に。引数ハッシュ + 前ハッシュ + 外部アンカーで監査 |

**何が防げて、何が防げないか**

- 防げる: 許可外ツールの呼び出し、許可外フローでのデータ持ち出し（CaMeL / Progent / AgentArmor の範囲）、既知の攻撃パターン（AgentDojo）、ツール記述子の差し替え（署名・不変版）。
- 防げない: 許可されたツール・許可された引数の範囲内での意味的攻撃（正当な宛先への誤送信、内容の改ざん）、ポリシー誤設定、悪意あるツール実装、承認疲れ、side channel、モデル自身の推論誤り。
- 数字の傾向: 決定論的なポリシー/能力層は ASR を 0–3% まで下げられるが、utility 低下 1–8% とポリシー記述コストを伴う。LLM guardrail は検出力 +10% 程度だが 15% 前後の残存があり、単独防御にはならない。

**採用に効いた研究**: Progent の「狭めるのは自動・広げるのは承認」は、OpenShell の prover/advisor より実装が軽く、hns の規模に合う。CaMeL の制御/データフロー分離は grant の scope 設計に使える。AgentDojo は受け入れ試験に、Auditable Agents の 5 次元は監査の評価軸に使える。

**採用しなかった研究**: 実行時 SMT（Zelkova/Cedar）はポリシー公開前の CI に限定する。LLM guardrail（ShieldAgent）は非同期監査に限定する。完全な CaMeL 型 planner/executor 分離は pi-durable の 1 ループを大きく変えるため、能力トークン部分だけ先に採る。gVisor / microVM は per-call では予算外。

**hns の強みと制約**: モデルがツール定義・ポリシーを書き換えられないため、Progent/CaMeL が前提とする「ポリシーは信頼済み」を満たす。MCP の記述子攻撃も現状は無関係。一方 **bash は引数の意味解析ができない**ので、研究の「引数規則」をそのまま適用すると抜ける。hns は「どの能力を渡すか」をポリシーで決め、実際の封じ込めは bwrap に任せるのが正しい。

## 7. hns への適用案

### Phase 0: 呼び出しの同一性と監査（1〜2 日）

- 正規化 JSON（RFC 8785 JCS）と SHA-256 の `callHash` を `packages/core` に置く。
- `defineTool` のメタデータ（toolId、version、riskClass、outputLimits、実装ハッシュ）を台帳化し、起動時に照合。
- ツール実行の前後で `callHash` を再計算。不一致は `denied`。
- イベントに `{callHash, argsDigest, toolId, version, policyRev, policyHash, grantId?, decision, reasonCode, ms}` を追加。**引数の生値は残さず、ハッシュと長さだけ**にする（秘密・PII を入れない）。
- 拒否コードを閉じた語彙に（`scope_exceeded` / `manifest_mismatch` / `grant_expired` / `epoch_stale` / `policy_denied`）。
- ツール定義とポリシーは D1 の immutable revision にし、DO はセッション開始時に revision + hash を snapshot する（hot path で D1 を読まない）。

**効果**: R1/R2 の基礎。速度への影響はほぼゼロ（ハッシュは µs）。**戻せる**: フラグで監査のみに。

### Phase 1: capability lease とローカル判定（1〜2 週）

- Workspace DO が grant を発行・署名（Ed25519）。秘密鍵は Worker/DO の secret。
- Machine Agent が grant を検証し、ローカルで引数スコープを判定。
- `epoch` は Workspace DO が持ち、失効時に bump。grant の TTL は 30〜60 秒。
- 読み取り系は grant で 0 往復。書き込みは既存の版チェックを維持（1 往復）。
- 監査イベントは非同期で DO に送る。拒否は即時、許可はバッチ可。
- **常駐 helper（0191）** を同じ Phase に入れ、write の per-op プロセス起動をなくす（目標 write p50 <10ms）。
- **承認 API は人間のセッションだけが呼べる**（agent の tool token では呼べない）。提案時に review token（現行 revision hash + 候補 + credential fingerprint の SHA-256）を返し、承認時に再計算して一致を要求する。D1 の CAS で「承認 + revision 更新 + audit」を原子的にする。

**効果**: L2 の削減。28ms → 署名検証 + ローカル判定（目標 p95 ≤ 5ms）。**リスク**: 失効の遅れ、grant の使い回し、時計ズレ。スパイク S3 で確認。

### Phase 2: egress と資格情報（2〜3 週、要件次第）

- `--unshare-net` + Unix socket proxy。既定拒否、host/port の allowlist、audit → enforce。
- ツールごとの資格情報スコープ。git/gh は GitHub App の installation token を Worker で mint し、repo / permission / TTL を限定する。長期 PAT をマシンに置かない。
- bwrap に seccomp（io_uring、AF_VSOCK）と Landlock（read 制約）を追加。
- ポリシー差分検証（E30）を、現時点は TS の集合包含で。拡大は人承認。

**効果**: データ持ち出しの経路を減らす。**コスト**: proxy の運用、DNS/TLS の互換、資格情報の UX。

### Phase 3: 投機・並列・最適化（必要になってから）

- 読み取り系の結果キャッシュ（path + version）。
- 独立な read の並列実行。
- read-only の投機実行（SPORK 型）は、誤予測のコストと副作用の危険を評価してから。
- 常駐 helper の効果測定（Phase 1 で導入済み）。

## 8. 検証計画（スパイク）

| ID | 問い | 方法 | 合格条件 | 時間 |
| --- | --- | --- | --- | --- |
| S1 | bwrap 内で Landlock の read 拒否が使えるか | NixOS 6.18 で bwrap + Landlock ABI v3+ の probe。symlink / `..` / bind mount の組合せ | root 外 read が拒否され、root 内は通る。bash p95 の悪化 ≤ 5ms | 1 日 |
| S2 | `--unshare-net` + UDS proxy で開発作業が通るか | git clone / npm install / curl / ssh を proxy 経由で。DNS と TLS を含む | 主要 4 操作が成功。p95 追加 ≤ 15ms。迂回経路なし | 2 日 |
| S3 | capability lease の安全性と速度 | grant の発行・検証・失効・リプレイ・期限・epoch のテスト。Ed25519 検証の ms | 不正 grant を全拒否。失効 ≤ 1s。検証 p95 ≤ 1ms | 2 日 |
| S4 | 正規化 JSON の一致 | JCS の実装を JS で。重複キー、Unicode、数値、`..`、symlink のコーパス | 100% 拒否または一致。JS と Rust/Go の一致（使う場合） | 2 日 |
| S5 | 引数レベルの制約で迂回を塞げるか | path/command/host の制約を valibot + 正規化で。攻撃コーパス | 既知の迂回を全拒否。正当な操作の誤拒否 ≤ 1% | 3 日 |
| S6 | helper 常駐で write <10ms | 0191 の方式。1 ワークスペース 1 プロセス | write p50 <10ms、integration <3s。TOCTOU の既存テストが通る | 3 日 |
| S7 | seccomp の穴を塞げるか | bwrap `--seccomp` で io_uring / AF_VSOCK を遮断 | 遮断を確認。bash の p95 悪化 ≤ 2ms | 1 日 |
| S8 | 監査の改ざん検知 | イベントのハッシュ連鎖。削除・改変・順序入替のテスト | すべて検知。書込みの追加 ≤ 2ms | 2 日 |
| S9 | git/gh の資格情報を絞れるか | GitHub App の installation token を Worker で mint。clone / push / pr を実行 | 主要操作が通り、長期 PAT がマシンに無い。監査に credential id が残る | 2 日 |
| S10 | 能力集合の差分を検証できるか | 既知の危険なポリシー変更 20 件を TS の集合包含で分類 | 拡大を 100% 検出。誤検知 ≤ 1 件。Worker で 100ms 未満 | 2 日 |
| S11 | 承認の principal と鮮度 | agent の token で承認 API を呼ぶ。review token を古くして承認する。CAS 競合 | すべて拒否。競合は 409。監査に承認者と revision が残る | 1 日 |
| S12 | tool call の trace コスト | tool の前後に span を出し、DO の CPU と遅延を測る | 追加 p95 ≤ 1ms。DO の CPU 予算内 | 1 日 |

**最初にやる順**: S3 → S4 → S11 → S6 → S1 → S7 → S2 → S5 → S9 → S10 → S12 → S8。S3/S4/S11/S6 は依存がなく、速度と統制への影響が大きい。

## 9. 未確定台帳

| ID | 未確定 | 仮説 | 影響する作業 | リスク | 責任者 | 期限/トリガー | 暫定対応 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| U-26 | grant の失効をどこまで即時にするか | 30〜60 秒 TTL + epoch push で足りる | Phase 1 | 中 | lead | S3 の結果 | TTL を短くし、危険操作は per-call |
| U-27 | 引数レベルの制約の表現力 | パス・コマンド分類・host で足りる | E24 | 中 | lead | S5 | まず read_file の path だけ |
| U-28 | egress を既定で切るか | 既定拒否 + allowlist。ただしビルドが壊れる | Phase 2 | 高 | lead | S2 | audit から開始 |
| U-29 | git/gh の資格情報をどこまで絞るか | マシンの既存設定を尊重しつつ、ツールからは見えにくく | E28 | 中 | lead | S9 の結果 | 現状維持 + 監査 |
| U-30 | ポリシー差分検証の範囲 | 現時点の能力集合なら包含で足りる（将来の拡大は前提にしない） | E30 | 中 | lead | S10 の結果 | 未対応は deny |
| U-31 | ツール実装の更新をどう承認するか | manifestHash の更新を明示操作に | E11/E25 | 中 | lead | Phase 0 | 更新は手動 |
| U-32 | 監査ログの保持と外部化 | DO + R2、ハッシュ連鎖 | R4 | 中 | lead | S8 | まず DO のみ |
| U-33 | OpenShell をそのまま使う可能性 | 使わない（Rust + Docker/VM + 独自 control plane が重い） | 全体 | 低 | lead | 再評価なし | 設計のみ参照 |
| U-34 | agent の tool token で承認 API を呼べないことをどう保証するか | 人間セッションと tool token を別 principal にし、method allowlist で拒否 | E45 | 高 | lead | Phase 1 | 承認 API を別 Worker にする |
| U-35 | review token と D1 CAS で承認を原子的にできるか | 1 トランザクションで revision 更新 + audit。競合は 409 | E45 | 中 | lead | Phase 1 | 失敗時は再提案 |
| U-36 | 監査の改ざん耐性をどこまで持つか | セッション単位の hash chain + Cloudflare R2 の anchor。object lock は未確認 | E46 | 中 | lead | S8 | まず hash chain のみ |
| U-37 | 読み取り系の投機・キャッシュを許すか | read_file は path + version でキャッシュ可。bash/write は不可 | Phase 3 | 中 | lead | S6 の後 | キャッシュのみ、投機は保留 |

### 9.1 後段で調べる候補

| # | 調べるもの | なぜ今でないか | 再開条件 |
| --- | --- | --- | --- |
| R-1 | OpenShell 0.2 と CNCF 移管後の API 安定性 | 0.1.x で契約が変わる。今は設計だけ参照 | 0.2 の release |
| R-2 | Cloudflare R2 の object lock / immutability | 監査の外部アンカーに使えるか未確認 | E46 の実装前 |
| R-3 | Workers / DO の Ed25519（WebCrypto） | grant 署名と検証の方式が決まらない | Phase 1 の着手前 |
| R-4 | macOS / Windows の sandbox backend | 0006 / 0033 / 0040 の範囲。今は Linux のみ | 非 Linux 対応の着手時 |
| R-5 | MCP 2026-07-28（sessionless）とツール完全性 | hns は MCP サーバではない。将来のブリッジ次第 | MCP クライアント対応時 |
| R-6 | microVM / gVisor の起動実測 | per-call では予算外。bwrap 不能ホストの fallback 候補 | bwrap が使えない環境の要件化 |
| R-7 | Wasm/WASI の純関数ツール | bash を置き換えない。計算・変換ツール限定 | ツール種別が増えたとき |

## 10. 出所

### OpenShell

- リポジトリ: <https://github.com/NVIDIA/OpenShell>（v0.1.8、2026-11-10、Apache-2.0、Rust）
- Architecture: <https://docs.nvidia.com/openshell/latest/about/architecture>
- Policies overview: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/overview>
- Policy schema: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema>
- Network rules: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/network-rules>
- Default policy: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/default-policy>
- Policy prover: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/prover>
- Policy advisor: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/advisor>
- Manage policies: <https://docs.nvidia.com/openshell/latest/how-it-works/policies/manage-policies>
- Security best practices: <https://docs.nvidia.com/openshell/latest/security/best-practices>
- MCP L7: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-supervisor-network/src/l7/mcp.rs>
- Prover README: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-prover/README.md>
- seccomp perf harness: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-sandbox/src/bin/seccomp-perf.rs>
- Landlock: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-sandbox/src/sandbox/linux/landlock.rs>
- seccomp notify: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-sandbox/src/linux/seccomp_notify.rs>
- binary identity: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-supervisor-network/src/identity.rs>
- approval guard: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-server/src/auth/sandbox_methods.rs>
- policy review token: <https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-server/src/grpc/policy.rs>
- RFC 0002 (agent-driven policy): <https://github.com/NVIDIA/OpenShell/blob/main/rfc/0002-agent-driven-policy-management/README.md>
- RFC 0009 (supervisor middleware): <https://github.com/NVIDIA/OpenShell/blob/main/rfc/0009-supervisor-middleware/README.md>
- RFC 0010 (gateway interceptors): <https://github.com/NVIDIA/OpenShell/blob/main/rfc/0010-gateway-interceptors/README.md>
- OCSF export: <https://docs.nvidia.com/openshell/latest/observability/ocsf-json-export>
- Security advisories: <https://github.com/NVIDIA/OpenShell/security/advisories>
- 2026-08 bulletin: <https://nvidia.custhelp.com/app/answers/detail/a_id/5872> / <https://github.com/advisories/GHSA-vrm8-9q5m-p369>

### hns

- [ARCH.md](../../ARCH.md)、[docs/safety.md](../../docs/safety.md)、[docs/topology.md](../../docs/topology.md)、[docs/observability.md](../../docs/observability.md)
- [packages/agent/src/tools.ts](../../packages/agent/src/tools.ts)、[packages/workspace/src/sandbox.ts](../../packages/workspace/src/sandbox.ts)
- [work/poc/cf-harness/RESULTS.md](../poc/cf-harness/RESULTS.md)
- [work/issues/0191-workspace-perf.md](../issues/0191-workspace-perf.md)、[0194](../issues/0194-machine-sandbox.md)、[0147](../issues/0147-machine-agent.md)、[0165](../issues/0165-safety-reeval.md)
- [work/research/sandbox-platforms.md](sandbox-platforms.md)

### 既製品・研究

- Claude Code sandboxing: <https://code.claude.com/docs/en/sandboxing.md>
- Claude Code sandbox-runtime: <https://github.com/anthropics/sandbox-runtime>
- Codex sandbox: <https://learn.chatgpt.com/docs/sandboxing.md>、<https://learn.chatgpt.com/docs/agent-approvals-security.md>
- Codex linux-sandbox README: <https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md>
- Codex seccomp: <https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/src/seccomp.rs>
- Gemini CLI sandbox: <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md>
- MCP authorization: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- MCP tool annotations: <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts>
- Docker MCP Gateway security: <https://github.com/docker/mcp-gateway/blob/main/docs/security.md>
- OPA performance: <https://github.com/open-policy-agent/opa/blob/main/docs/docs/policy-performance.md>
- AgentDojo: <https://arxiv.org/abs/2406.13352>
- CaMeL: <https://arxiv.org/abs/2503.18813>
- Progent: <https://arxiv.org/abs/2504.11703>
- AgentArmor: <https://arxiv.org/abs/2508.01249>
- AgentSpec: <https://arxiv.org/abs/2503.18666>
- ShieldAgent: <https://arxiv.org/abs/2503.22738>
- ToolEmu: <https://arxiv.org/abs/2309.15817>
- MCP descriptor attacks: <https://arxiv.org/abs/2512.06556>、<https://arxiv.org/abs/2506.01333>
- Capsicum: <https://www.usenix.org/conference/usenixsecurity10/capsicum-practical-capabilities-unix>
- WASI capabilities: <https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md>
- Zelkova: <https://d1.awsstatic.com/Security/pdfs/Semantic_Based_Automated_Reasoning_for_AWS_Access_Policies_Using_SMT.pdf>
- Cedar: <https://arxiv.org/abs/2403.04651>
- Cedar VGD: <https://arxiv.org/abs/2407.01688>
- LLMCompiler: <https://arxiv.org/abs/2312.04511>
- PASTE: <https://arxiv.org/abs/2603.18897>
- Agentic Plan Caching: <https://arxiv.org/abs/2506.14852>
- SPORK: <https://arxiv.org/abs/2607.03333>
- ToolSpec: <https://aclanthology.org/2026.emnlp-main.409/>
- FANTASE: <https://aclanthology.org/2024.findings-emnlp.359/>
- CIBA: <https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0-final.html>
- Auditable Agents: <https://arxiv.org/abs/2604.05485>
- NovaFabric: <https://arxiv.org/abs/2609.12582>
- gVisor cost: <https://www.usenix.org/conference/hotcloud19/presentation/young>
- Firecracker (NSDI 2020): <https://www.usenix.org/conference/nsdi20/presentation/agache>
- Landlock study: <https://doi.org/10.1109/ISDFS69419.2026.11459106>
- seccomp notify microbench: <https://lists.openwall.net/linux-kernel/2023/03/08/249>
- stdio/HTTP latency: <https://benchivo.com/developers/stdio-vs-http-latency/>
- Firecracker: <https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md>
- Landlock: <https://docs.kernel.org/userspace-api/landlock.html>
- seccomp: <https://docs.kernel.org/userspace-api/seccomp_filter.html>

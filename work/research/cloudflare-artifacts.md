# Cloudflare Artifacts の hns への適用調査

2026-11-17 / 対象: Cloudflare Artifacts（open beta, 2026-11 時点） / 一次資料: [Artifacts docs](https://developers.cloudflare.com/artifacts/), [2026-11-16 の changelog](https://developers.cloudflare.com/changelog/post/2026-11-16-local-artifacts-development/)

## 0. 結論

- Artifacts は「Git を喋る、複製済みでフォークできるファイルツリーの置き場」で、hns の **C（checkpoint commit）の置き場とほぼ同じもの**をマネージドで提供する。R2 の pack 置き場・restore・保持 GC を自前で作る代わりに、標準の Git として持てる。
- 一番インパクトが大きいのは保存先の差し替え自体ではなく、**「workspace = repo、Run = commit / branch」にすると、レビュー・引き渡し・並列探索・バックアップが同じ一つの仕組みから出てくる**こと。特に「UI がマシンに繋がらなくても checkpoint の差分を読める」「人間が `git fetch` で Run を持ち帰れる」「baseline から fork して複数案を並べられる」は、今の設計（読みはマシンから、単一 writer）では作りにくい。
- ただし **1 repo 1GB / 1 file 32MiB / 1 push 64MiB / GC API なし / open beta** の4点が設計を縛る。C の正本を丸ごと移す前に、ローカルシミュレータでの検証（この調査で実施済み）と、本番での push レイテンシ・課金・容量の実測を1本挟むべき。

## 1. Artifacts のモデル（一次資料の要約）

| 要素 | 内容 |
| --- | --- |
| 単位 | namespace → repo。repo は独立した Git サービス（history / refs / remote / token / lifecycle を持つ） |
| インターフェース | control plane = Workers binding / REST / Wrangler、data plane = Git smart HTTP（`https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`） |
| 認証 | repo-scoped token（`read` / `write`、TTL 付き）。control plane は Cloudflare API token、binding は binding 自体 |
| 読み取り API | binding に `info` / `log` / `readCommit` / `readTree` / `readBlob` / `readFile` がある。**書き込み API は無い**（push は Git、Worker 内なら isomorphic-git） |
| フォーク | `fork(name, { defaultBranchOnly })`。新しい repo として独立し、token も別 |
| イベント | `repo.created` / `repo.forked` / `repo.pushed`（ref / before / after / commits）などを Queues の event subscription で購読 |
| 耐久性 | repo データを複数データセンターへ同期複製し、非同期で object storage / snapshot へ。「durable by default」 |
| 所在地 | namespace 作成時に `eu` / `us` を選択（後から変更不可） |
| 提供条件 | Workers Paid のみ。2026-10-01 に open beta、**2026-11-19 から課金開始**（repo 課金は今後） |

### 制限（[Limits](https://developers.cloudflare.com/artifacts/platform/limits/)）

| 項目 | 値 |
| --- | --- |
| repo あたりの保存量 | **1 GB**（2026-09-29 以降に作った repo。以前は 10 GB） |
| account あたりの保存量 | 1 TB（申請で増可） |
| 1 file | **32 MiB** |
| 1 push | **64 MiB** / 50,000 objects |
| レート | namespace あたり control plane 2,000 req/10s、repo あたり Git 2,000 req/10s |
| 1 folder | 100,000 entries |

### ローカル開発（2026-11-16 の changelog）

Wrangler 4.163.0+ / Git 2.32+ / Vite plugin 2.0.0-rc.0+ / `@cloudflare/vitest-plugin` 1.8.3+ で、**Cloudflare アカウント無しにローカルで repo を作り、clone / push できる**。local repo は本番と別で、イベントも同じものが流れる。binding に `remote = true` を付けると本番の repo を使う。

## 2. この環境で実際に動かした結果（検証）

`.work/artifacts-probe` に最小の Worker を作り、`wrangler dev`（4.163.0, compatibility_date `2026-11-16`, git 2.56）で確認した。**Cloudflare アカウントと課金は使っていない**（local simulator）。確認できたこと:

| 試したこと | 結果 |
| --- | --- |
| `env.ARTIFACTS.create()` → remote / token | 成功。remote は `http://127.0.0.1:<port>/git/default/<repo>.git` |
| 空 repo へ `git push` main | 成功 |
| `refs/heads/hns/run-2`（入れ子 branch）へ push | 成功。`ls-remote` に出る |
| `refs/hns/checkpoints/run-1`（branch/tag でない ref）へ push | **成功**。ただし binding の `readFile` / `log` では解決できなかった |
| `refs/tags/hns-run-1` へ push | 成功。binding から tag 名で読める |
| `readFile` を commit hash で読む | 成功（**hash 指定が一番確実**） |
| `readTree` / `log` | 成功（tree は直下のみ。mode / hash / type を返す） |
| `fork(defaultBranchOnly: true)` | default branch と、その上の tag はコピー。**heads 配下の他 branch と `refs/hns/*` はコピーされない** |
| `fork(defaultBranchOnly: false)` | 全 heads + tags をコピー。**`refs/hns/*` はコピーされない** |
| `git push --delete refs/heads/...` | 成功 |
| 33 MiB の file を push | **拒否**（`Artifacts does not accept files larger than 32 MiB ... pre-receive hook declined`） |
| 20 MiB の file を push → `readFile` | 成功（32 MiB 以下なら binding で読める） |
| 2 MB の tree を push | ローカルで 177 ms（本番のネットワーク往復は未計測） |
| shallow clone（`--depth 1 --branch hns/run-2`） | 成功 |
| 単一 ref の fetch（`git fetch <remote> refs/hns/checkpoints/run-1`） | 成功（restore はこれで足りる） |

**読み取り API の ref 解決**: branch 名・tag 名・commit hash は解決するが、`refs/hns/checkpoints/...` のような「heads でも tags でもない ref」は解決しなかった。hns が ref を独自名前空間に置くなら、**heads 配下（例: `refs/heads/hns/checkpoints/<runId>`）にするか、commit hash を DO に持って hash で読む**のが安全。fork に checkpoint を載せたいなら heads 配下が必須（fork は heads と tags しか運ばない）。

未検証（本番アカウントが要る）: push の p95 レイテンシ、複数拠点複製の ack 意味、1 GB 到達時の挙動、fork の保存量課金（object 共有か複製か）、課金の実額、リージョン（jurisdiction）と DO / D1 の位置関係。

## 3. hns の現状との対応

hns の正本は `(C, J)`（[durability.md](../docs/durability.md)）。C は「checkpoint commit から辿れる object を 1 pack にして R2 の `checkpoints/<commit>.pack` に置く」で、[0153](../work/issues/0153-r2-object-store.md) は done、[0154](../work/issues/0154-checkpoint-commit.md)（checkpoint commit）、[0155](../work/issues/0155-restore.md)（restore）、[0168](../work/issues/0168-retention-gc.md)（保持 GC）は open、[0164](../work/issues/0164-backup-restore-ops.md)（backup）も open。

| hns の要素 | Artifacts で置き換えると |
| --- | --- |
| C の object 置き場（R2 pack, 0153） | repo の object（push した commit / tree / blob） |
| restore（0155: pack を index して object を引く） | `git fetch <remote> <commit>` → checkout（git が参照実装） |
| 保持 GC（0168: reachability で object を残す） | **API が無い**。repo を世代で分ける / squash する設計が要る |
| backup（0164: export） | 全 repo を `git clone` するだけ（repo が自己記述的） |
| `refs/hns/checkpoints/<runId>` | そのまま push できる。ただし binding からは hash で読む |
| 読みはマシンから（durability.md §4） | **C に限り** UI / Worker から読める（U は依然マシン） |
| 単一 writer（INV-13, lease） | そのまま。fork は「別 workspace の別 writer」として整合させる |

## 4. インパクトのある使い方

### 案B（本命）: workspace = repo、checkpoint = commit、Run = branch

```text
machine: 作業ツリーを commit
        → git push <remote> HEAD:refs/heads/hns/run/<runId>   (write token, TTL 15min)
        → push ack
        → Workspace DO: C = <commit>, watermark, J を切り詰め

restore: Workspace DO が read token を発行
        → 新しいマシン: git fetch <remote> <commit> --depth 1 → checkout
        → J を seq 順に再生（U は戻らない）

UI: Worker binding が log / readTree / readFile(<commit>) を呼ぶ
        → マシンがオフラインでも checkpoint 時点の差分・履歴を表示
```

効く理由:

- **保存の実装が減る**: pack の作り方・index・reachability GC・object lock の整合（0153 / 0155 / 0168）を、Git の意味論に委ねられる。restore は「fetch して checkout」になり、壊れ方の種類が減る。
- **UI の読みが速く・強くなる**: 今は「ファイルはマシンから読む」（U が見えないため）。C に限れば Worker が直接読めるので、**マシンが落ちていても Run の差分を見られる**。Git Diff Viewer（README の Want #10）の土台になる。
- **引き渡しが Git になる**: 人間は UI が出す短命 token で `git fetch` し、自分のエディタで差分を見て、必要なら push で返せる。Artifacts の「Git-aware tools / agents に渡す」という設計意図とそのまま一致する。
- **token が repo に閉じる**: マシンには「その workspace の repo だけ・短命」の write token を渡せる。共有秘密を配るより事故の影響範囲が小さい。

### 案C（差別化）: fork で並列探索・比較・マージ

```text
baseline repo ──fork──▶ candidate A（agent A が push）
              ├─fork──▶ candidate B（agent B が push）
              └─fork──▶ candidate C
比較: 3 repo を手元に fetch して diff / テスト
採用: 勝った候補を baseline に merge（通常の git）
```

今の hns は「同じ workspace の同時編集はしない」（INV-13）ので、並列探索は **workspace を分ける**形になる。Artifacts の fork はその分離を安くする。製品にすると「同じ依頼を N 案で走らせ、diff とテストで選ぶ」という、単一 writer の制約と矛盾しない新しい UX になる。repo を分けるので lease も版も汚さない。

### 案D（すぐ効く）: ローカルシミュレータで checkpoint / restore をテストする

[0154](../work/issues/0154-checkpoint-commit.md) / [0155](../work/issues/0155-restore.md) / [0167](../work/issues/0167-remote-fault-injection.md) の検証は、これまで R2 と実アカウントが前提だった。ローカル Artifacts なら **アカウント無しで「push → fetch → checkout」を通しで試せる**（この調査で動作確認済み）。CI でも回せる。Wrangler 4.163+ への更新と compatibility_date の引き上げ（今は 2026-10-30）が前提。

### 案A（低リスク代替）: R2 を正本のまま、Artifacts にミラーする

C は今どおり R2。Run の終わりに同じ commit を Artifacts にも push し、**レビュー・引き渡し・fork・UI 読み取りだけ**を Artifacts から行う。RPO と beta 依存のリスクを変えずに、案B/C の体験を先に取れる。保存が二重になる代わりに、移行の失敗が正本を壊さない。

### やらない方がよいこと

- **Artifacts を Journal（256KB 超の本文）の置き場にする**: R2 の方が安く単純。Artifacts は「commit されたツリー」のため。
- **Workers Builds / Artifacts の build & deploy 連携**: 「Cloudflare 上でワークロードを実行しない」（ARCH / D047）に反する。hns の外の話として切る。
- **Artifacts の推奨どおり repo per session にする**: 今の規模では repo 数が増えるだけで、workspace の履歴が分断される。repo 課金（今後）と 1 GB 上限を考えると、**workspace = repo / Run = branch** が hns に合う。
- **checkpoint を `refs/hns/*` に置く**: push はできるが binding から読めず、fork でも運ばれない。heads 配下か tag にする。

## 5. 設計上の制約と落とし穴

| 制約 | 何が起きるか | 対処 |
| --- | --- | --- |
| 1 repo 1 GB | 長く使う workspace は履歴で上限に達する。到達時の挙動は未検証 | 70% で警告。世代 repo（`<workspace>-g2`）に切り替えて古い世代を read-only → 保持期間後に削除。squash（新しい root commit）で作り直す |
| 1 file 32 MiB / 1 push 64 MiB | 32 MiB 超の file があると **checkpoint が失敗**し、RPO 1 Run が崩れる | push 前に検査。超える file は R2 に逃がす（今の `objects.ts` の経路を残す）。初回 push が 64 MiB を超える場合は分割 |
| GC API がない | 消した ref の object がいつ消えるか保証されない。storage は減らない前提 | 「保持は repo の削除で行う」と決める。0168 を「object GC」から「repo 世代の保持」に書き換える |
| fork は heads / tags だけ運ぶ | checkpoint を独自 ref に置くと fork 先で消える | checkpoint は `refs/heads/hns/...` か tag。あるいは fork 後に push し直す |
| binding の ref 解決 | 独自 ref は読めない。`log` は first-parent のみ | commit hash を DO に持つ（watermark と一緒）。UI は hash で読む |
| open beta / 課金開始 | API・上限・価格が変わり得る。2026-11-19 から課金 | feature flag。R2 経路を残す。課金は月次で監視 |
| push ack の意味 | 「同期複製」と書いてあるが、ack = durable の契約文は無い | 本番で検証するまで C の正本にしない（案A で始める）。契約が取れれば案B |
| 本番レイテンシ | Run 終わりの push が R2 put より遅い可能性 | run 終わりだけなので RPO には効かないが、lease 解放・引き渡しの待ち時間に効く。p95 を測る |
| 依存の深さ | 正本が Cloudflare の新サービスに乗る（D047 の延長だが、beta 依存は増える） | export（clone）を常に可能にしておく。案A なら影響は表示だけ |

## 6. 費用（公開価格での概算）

- Operations: 月 10,000 まで無料、以降 $0.15 / 1,000。Run 1 回 = push 1 + fetch 数回。**月 1,000 Run でも無料枠**。
- Storage: 月 1 GB まで無料、以降 $0.50 / GB-mo。workspace 5 個 × 200 MB = 1 GB で無料。10 GB なら約 $4.5/月。
- Repo: 100,000 まで無料、以降 $0.01/repo/月（**開始時期は未告知**）。workspace 数なら無視できる。repo per run にすると効いてくる。

単一ユーザーの規模では**金額は判断理由にならない**。判断理由は 1 GB 上限・32 MiB 上限・beta 依存・実装削減の4点。

## 7. 採用シナリオ（推奨）

1. **今週**: ローカルシミュレータで 0154 / 0155 の通し（push → fetch → checkout → J 再生）をテストに落とす。Wrangler 4.163+ と compatibility_date の更新を確認（deploy の `cf` は beta.28 でも `bindings.artifacts` を export している。最新は 1.0.0-rc.0）。
2. **次**: 1 workspace を本番 Artifacts に**ミラー**（案A）。push の p95、課金額、1 GB までの伸び、fork の保存量を実測。C の正本は R2 のまま。
3. **判断**: ack が durable と確認でき、p95 と費用が許容なら、C を Artifacts に移す（案B）。0155 を fetch + checkout に、0168 を repo 世代の保持に、0164 を clone export に書き換える。
4. **発展**: fork ベースの並列探索（案C）を製品機能として設計。lease / INV-13 との整合を先に決める。

## 8. 決める必要があること

- C の正本を Artifacts にするか（R2 併存か）。その条件は「push ack = durable」をどう確認するか。
- repo の粒度: workspace / 世代 / run。
- checkpoint の ref 名: `refs/heads/hns/run/<runId>`（fork で運べる）か、commit hash のみか。
- 32 MiB 超の file と 64 MiB 超の初回 push の扱い（R2 併用か、除外か）。
- 保持: repo 世代 + 期間か、squash か。0168 の書き換え。
- fork 並列探索を製品にするか（作るなら「同じ依頼を N 案」の UX とテストの持ち方）。
- beta 依存を許容する範囲（表示だけ / 正本）。

## 9. 参考

- [Artifacts](https://developers.cloudflare.com/artifacts/) / [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/) / [Limits](https://developers.cloudflare.com/artifacts/platform/limits/) / [Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
- [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) / [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) / [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) / [Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) / [Local development](https://developers.cloudflare.com/artifacts/guides/local-development/)
- [2026-11-16 changelog](https://developers.cloudflare.com/changelog/post/2026-11-16-local-artifacts-development/) / [2026-10-01 open beta](https://developers.cloudflare.com/artifacts/platform/changelog/)

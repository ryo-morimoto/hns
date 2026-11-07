# コミット時チェックの最適化: 要件とツール調査

2026-11-07。対象は `.githooks/pre-commit` → `npm run check` の一連。
行ったこと: 現状の実測（このリポジトリ、Node 26.13 / npm 11.20 / Vitest 5.1.0）、要件の洗い出し、
要件に合うツール・仕組みの調査。

2026-11-07 追記: ①段階分割と②パッケージ単位の選別を `tools/gate/` に実装した（D050）。
③遅い層の分離は 0170、④build の pre-push 移行は 0171。

## 0. 目的と非目的

**目的**: コミットごとの待ち時間を「そのコミットが壊しうる範囲」に比例させる。あわせて、検査の定義を
1か所に集め、追加・削除・無効化を1エントリで済ませられるようにする。

**非目的**: CI の構築（0041、未着手）。テスト自体の高速化（fixture や sandbox の見直し）。
どちらも別 issue。ここで決めるのは「何を、いつ、どこに定義して走らせるか」だけ。

**現状の一言**: 1行の bash が `npm run check` を呼び、その中で6段階が毎回リポジトリ全体に対して走る。
段階の分離がなく、変更を見ていない。

## 1. 現状の実測

### 1.1 何が動いているか

`.githooks/pre-commit`（5行）:

```bash
cd "$(git rev-parse --show-toplevel)"
command -v node >/dev/null || { echo "pre-commit: run inside nix develop" >&2; exit 1; }
exec npm run check
```

`npm run check` = `lint && fmt:check && typecheck && test && build && knip`。`core.hooksPath=.githooks`。

| 段階 | 実体 | 範囲 |
| --- | --- | --- |
| lint | `oxlint packages` | 全体 |
| fmt:check | `oxfmt --check packages` | 全体 |
| typecheck | `tsrs --noEmit` × 5 パッケージ | 全体 |
| test | `vitest run`（6プロジェクト / 21ファイル / 204テスト） | 全体 |
| build | `tsc -p tsconfig.build.json` × 4 + web の `tsc && vite build` | 全体 |
| knip | `knip` | 全体 |

### 1.2 実測（グリーンなツリー、1回ずつ）

| 段階 | 時間 | 全体比 |
| --- | --- | --- |
| lint | 0.32s | 1.6% |
| fmt:check | 0.06s | 0.3% |
| typecheck（5パッケージ） | 0.63s | 3.1% |
| **test** | **12.91s** | **63%** |
| **build** | **5.52s** | **27%** |
| knip | 0.49s | 2.4% |
| 合計（npm 起動込み） | **約 20.3s** | |

テストの内訳（プロジェクト単位、単独実行）:

| プロジェクト | 時間 | テスト数 |
| --- | --- | --- |
| workspace | **12.46s** | 66 |
| agent | 3.71s | 16 |
| web | 1.09s | 29 |
| store | 0.34s | 32 |
| core | 0.32s | 61 |

workspace の 12.5s は3ファイルが支配する（並列実行なので最大値が効く）:
`workspace.test.ts` 11.95s / `toctou.test.ts` 7.20s / `hardening.test.ts` 7.05s（`sandbox.test.ts` は 0.42s）。
agent は `agent.test.ts` が 3.73s（`keys.test.ts` は 0.39s）。

### 1.3 変更の実態（直近 133 コミット）

| 事実 | 数 |
| --- | --- |
| `packages/` に触れないコミット | **94（71%）** |
| `packages/` に触れるコミット | 39（29%） |
| うち core のみ | 16 |
| うち web / store のみ | 各 3 |
| 1コミットの変更ファイル数（中央値 / p90 / 最大） | 6 / 16 / 47 |

つまり **7割のコミットは 20 秒払う理由が無い**。133 × 20s ≈ 44 分、うち約 31 分が不要な待ち。

### 1.4 重いのはどこか

遅いのは test（63%）と build（27%）だけで、lint / fmt / typecheck / knip は合計 1.5 秒。
**「ステージ済みファイルだけに lint をかける」最適化はほぼ効果が無い**（実測: oxfmt は 1ファイルでも 56ms、
全体でも 56ms。oxlint は 319ms → 164ms）。効くのは「テストとビルドを、どの範囲で、いつ走らせるか」。

### 1.5 メンテナンス上の問題（「やりづらい」の中身）

1. 検査は1本の `&&` 連鎖で、**段階を個別に実行できない**。落ちた段階の切り分けは npm の出力を読むしかない。
2. 検査を足すには `package.json` の scripts・連鎖・AGENTS.md の3箇所を直す。順序の制約がコードに埋まる。
3. hook は**何も判断していない**（判断はすべて npm scripts 側）。「どのコミットで何を走らせるか」を書く場所が無い。
4. **警告が落ちない**。oxlint は警告ありで exit 0（実測: `no-unused-vars` が 1 件出て rc=0）。ゲートの意味が弱い。
5. **未ステージの WIP で落ちる**。作業ツリー全体を見るので、関係ない編集中ファイルの整形崩れでコミットが止まる
   （実測: 今このツリーで `fmt:check` が `packages/web/src/app/Shell.tsx` で失敗し、無関係なコミットができない）。
6. **nix 前提が hook に漏れている**。node が PATH に無い環境では「run inside nix develop」で止まるだけ。
7. 遅いテストと速いテストの区別が無く、**全部が同じ段階**にある。

## 2. 要件

Must は満たさないと目的を果たせない。Should は次の設計で決める。Could は余力。

### A. スコープ（何を対象にするか）

| ID | 要件 | 受け入れ条件 | 現状 |
| --- | --- | --- | --- |
| R-01 | コミットは**ステージ済みの内容**を検査する | 未ステージの変更がコミットを止めない。部分ステージでは index の内容が検査される | 作業ツリー全体を見る |
| R-02 | 変更ファイルから**所属パッケージ**を判定する | `packages/web` だけの変更で core / workspace のテストを回さない | 常に全部 |
| R-03 | 依存の向きで**影響範囲を広げる** | core 変更 → core に依存する全パッケージ。web 変更 → web のみ | 常に全部 |
| R-04 | **検査対象外のパス**を宣言できる | `docs/` `work/` `*.md` だけのコミットが 0.5 秒未満で終わる | 20 秒 |
| R-05 | **全量に切り替わる条件**を明示する | lockfile / tsconfig / vitest.config / ツール設定の変更、および明示指定で全パッケージを対象にする | 常に全量（＝条件が無い） |

補足: R-03 の根拠は `exports` の `"source"` 条件。実行時もテストも `src` を直接読むので、core の変更は
依存側の型検査・テストに波及する。影響グラフは `npm query '.workspace'` で取れる（後述）。

### B. 段階（いつ、何を走らせるか）

| ID | 要件 | 受け入れ条件 | 現状 |
| --- | --- | --- | --- |
| R-06 | 段階を**独立に実行**できる | `lint` / `fmt` / `typecheck` / `test` / `build` / `knip` を単独で呼べる | `check` のみ |
| R-07 | コミット前に置くのは**速い検査だけ** | 典型 5 秒未満、core/agent 変更時でも 10 秒未満 | 20 秒 |
| R-08 | **build をコミット前から外す** | pre-commit で `tsc -p tsconfig.build.json` / `vite build` を走らせない | 5.5 秒（27%） |
| R-09 | **遅いテストを分離**する | 「速い層」の定義が1か所にあり、pre-commit は速い層のみ。全量は push / CI | 全部コミット前 |
| R-10 | 段階ごとの**失敗が即座に分かる** | どの段階・どのファイルで落ちたかが1画面で出る | npm の出力を読む |
| R-11 | **警告も失敗**として扱う | `oxlint` が警告で exit 0 しない | 警告が素通り |

R-08 の根拠: AGENTS.md の「Building is not proof of correctness; types and tests are」。
build が型検査より多く捕まえるのは declaration emit の失敗（TS4023 等）と bundler 固有の失敗だけ。
どちらも push 前 / CI で足りる。R-09 の候補: workspace の sandbox / TOCTOU / hardening（12.5s）と
`agent.test.ts`（3.7s）が「遅い層」。ここを外すと pre-commit のテストは約 1.8 秒になる。

### C. 定義と保守（「メンテしづらい」への直接の答え）

| ID | 要件 | 受け入れ条件 | 現状 |
| --- | --- | --- | --- |
| R-12 | 検査の定義が**1ファイル**に集まる | 検査の追加・削除・並び替えが1エントリの編集で済む。bash にロジックを書かない | package.json ほか3箇所 |
| R-13 | 各ツールの設定を**二重管理しない** | oxlint / oxfmt / vitest / tsrs / knip の設定ファイルはそのまま使う | 満たす |
| R-14 | hook の導入が**1コマンド** | clone 直後に有効。`core.hooksPath` の手動設定に依存しない | 手動1行 |
| R-15 | **nix 環境を吸収**する | node が無いとき、何をすればよいかが出る（または自動で dev shell に入る） | エラー文言のみ |
| R-16 | ローカルと CI が**同じ定義**を使う | 定義の複製が無い（CI は将来、同じ定義を呼ぶ） | CI が無い |
| R-17 | **スキップ手段**がある | 段階指定のスキップと `--no-verify`。スキップした事実がログに残る | `--no-verify` のみ |

### D. 正しさ（速くするときに壊さない）

| ID | 要件 | 受け入れ条件 | 現状 |
| --- | --- | --- | --- |
| R-18 | 削除・リネーム・intent-to-add の扱いを決める | `--diff-filter` と `git add -N` の挙動が決まっている | 未定義 |
| R-19 | 自動修正と再ステージの方針を決める | `oxfmt --write` を実行して `git add` するか、check のみか | check のみ |
| R-20 | キャッシュを使うなら**無効化条件を明示**する | ツール版・設定・lockfile の変更で全量に戻る | キャッシュ無し |
| R-21 | **走らなかったことを表示**する | 「docs のみ → 検査なし」が出力に出る（無言で緑にしない） | 常に全部走る |

R-21 は重要。速くする変更は「何も検査していないのに緑」を作りやすい。

### E. 性能の目標

| ID | 要件 |
| --- | --- |
| R-22 | docs / work のみ: < 0.5s ・ 1パッケージのみ: < 3s ・ core 変更: < 10s ・ push または CI: 全量（約 20s + build） |

### F. 観測

| ID | 要件 |
| --- | --- |
| R-23 | 各段階の所要時間を表示する（遅い段階がその場で分かる） |
| R-24 | 遅いテストの内訳が見える（層の分け方を根拠づける） |

## 3. 調査した仕組み

調査は「対象を絞る部品」と「段階を定義して実行する部品」に分けた。前者はどの runner を選んでも必要になる。

### 3.1 対象を絞る部品

**(a) ステージ済みファイルの列挙（git）** — ここは自作するなら罠が多い。

| コマンド | 挙動 |
| --- | --- |
| `git diff --cached --name-only --diff-filter=ACMR` | staged のみ。rename は新パスだけ、**削除は出ない** |
| `git diff --cached --name-only`（filter 無し） | rename は旧+新の2行、削除も出る |
| `git add -N` したファイル | `--cached` に**出ない**（検査から漏れる） |
| `git diff <base>...HEAD` | merge-base 比較。base が無いと `$(...)` が空になり、引数なし diff（作業ツリー）に化ける |
| サブモジュール | パス1個（ディレクトリ）が返る。linter に渡すと事故 |
| パス基準 | git ルート相対。サブディレクトリ起動に注意 |

重要な帰結: **ファイル名を絞っても、oxlint / oxfmt / tsc / vitest が読むのは作業ツリーのファイル**。
ステージ後に編集したファイルがあると「検査した内容 ≠ コミットされる内容」になる。これを埋めるのが
lint-staged / pre-commit / lefthook の stash 機構で、R-01 の「内容」を満たすにはそれが必要。
本リポジトリは未ステージの WIP が常にあるので、ここは効果が大きい。

**(b) パッケージの影響範囲** — npm だけでも取れる。

```
$ npm query '.workspace' | jq ...
@hns/agent: @hns/core, @hns/workspace
@hns/store: @hns/core
@hns/web:   @hns/core
@hns/workspace: @hns/core
```

実測でそのまま動く（npm 11.20）。これで「変更パッケージ + 被依存の閉包」を20行程度で計算できる。
タスクランナーを使う場合、turbo は `--filter=...[HEAD^1]` / `--affected`、nx は `nx affected`、
moon は `moon query affected` が同じことをする（後述）。

**(c) テスト選択** — Vitest の `--changed` は**このリポジトリでは使えない**（実測）。

| 試行 | 結果 |
| --- | --- |
| クリーンな clone、変更なし、`--changed` | テスト0件で終了（正しい） |
| クリーンな clone、`core/workflow.ts` を1行変更 | core の 5 中 3 ファイル（正しい） |
| クリーンな clone に**未追跡ファイルを1つ置く** | **5/5 全実行**（フォールバック） |
| 実リポジトリ（未追跡 docs が90件） | **常に全実行**。しかも「Affected」表示すら出ない |

理由は実装にある。依存記録を持たないプロジェクトに対して、選択処理は `return specs`（＝全部）で返す
（`cli-api` の `findAffectedInProject`）。実験でも、未追跡の docs ファイルを1つ置いただけで全実行に戻った。
docs だけのコミットが 71% を占めるこのリポジトリでは、
**`--changed` は「全実行」とほぼ同義**になる。さらにハブ（core）変更では transform のコストで
全実行とほぼ同じ（研究側の実測で 10.67s vs 10.88s）。
一方 **`--project` は確実に効く**（実測: core+store 0.37s、core+store+web 1.45s）。だから単位は
「ファイル」ではなく「**パッケージ（プロジェクト）**」に置くのが正しい。

`--sinceLastRun`（5.1.0 experimental、`experimental.recordDependencies` 前提）は実行時依存を記録するので
理屈は合うが、実験的で、mtime 依存の注意が docs にある。今は採らない。

**(d) 型検査** — パッケージ単位で足りる。実測で 5 パッケージ合計 0.63s。`--incremental` は
core で 870ms → 481ms（クローンで実測）だが、**そもそも 0.6 秒なので投資対効果が無い**。
tsc/tsrs は**ファイルリストを渡すと tsconfig を無視する**ので、「変更ファイルだけ型検査」は原理的に不可。

**(e) lint / format** — 固定コスト。oxfmt は 1ファイルでも全体でも 56ms、oxlint は 319ms → 164ms。
選別の効果はほぼ無い。ただし落とし穴が2つ: oxfmt は **Markdown も整形対象**（`docs/testing.md` が現状 exit 1）なので
「ステージされた全ファイル」を素通しすると docs で落ちる。oxlint は**警告で exit 0**（R-11）。

**(f) knip** — 本質的に全グラフ。`--cache` で 513ms → 348ms、`--workspace` で範囲を絞れるが
「変更ファイル」モードは無い。コミット前から外すか、push 側に置くのが妥当。

### 3.2 段階を定義して実行する部品（hook ランナー）

| | lefthook | husky + lint-staged | prek | hk | pre-commit (Python) | simple-git-hooks |
| --- | --- | --- | --- | --- | --- | --- |
| ステージ済みファイル | `{staged_files}` | する（本体） | する | する | する | しない |
| 部分ステージの退避 | する（設定不可） | する（`--no-hide-*` で制御） | する | する（`git add -N` も明示処理） | する | しない |
| 並列 | ジョブ単位 | glob 単位 | 同一 priority 内 | ステップ + ファイルロック | 直列 | なし |
| glob で絞る | `glob` / `exclude` | glob キー | regex / `glob` | `glob` / `exclude` | regex + 型タグ | なし |
| monorepo 認識 | なし（`root` と `extends`） | 設定ファイル単位 | project 単位 | `workspace_indicator` | なし | なし |
| 結果キャッシュ | なし | なし | なし | なし | なし | なし |
| 設定 | `lefthook.yml` | `.husky/` + `.lintstagedrc` | `.pre-commit-config.yaml`/`prek.toml` | `hk.pkl`（要 Pkl・初回ネット） | YAML | package.json |
| 導入 | npm / nixpkgs、`lefthook install` | npm、`husky init` | 単一バイナリ | mise/brew/cargo/nix | pip | npm、postinstall |
| 注意 | `git add -N` で失敗する既知 issue（#1561, open） | `core.hooksPath` を奪う | 新しい（v0.x） | Pkl の学習コスト | Node リポジトリには過剰 | 機能が最小 |

要点:
- **「段階を1か所で宣言する」**という要求（R-12）は、上のどれでも満たせる。違いは
  ステージ内容の退避（R-01）と並列（R-23 の一部）を自前で書くか借りるか。
- **npm workspaces の影響範囲を計算するツールは無い**。ここは 20〜40 行の自前スクリプトが残る。
- husky は既存の `core.hooksPath=.githooks` と衝突する。lefthook / prek は repo-local の
  `core.hooksPath` を尊重する。hk は Git の config-based hooks を使う。

### 3.3 キャッシュ付きタスクランナー

| | turbo | nx | moon | wireit | npm workspaces（現状） |
| --- | --- | --- | --- | --- | --- |
| affected | `--affected` = `...[main...HEAD]` | `nx affected`（task inputs 単位） | `moon query affected` | なし（フィンガープリント） | **なし** |
| 結果キャッシュ | 内容ハッシュ、local + remote | 内容ハッシュ、local + Nx Cloud | local + RE API v2 | local（10 entry LRU）+ GH Actions | **なし** |
| 設定 | `turbo.json` | `nx.json`（+ project.json） | `.moon/` + toolchain | package.json 内 | なし |
| 依存追加 | 1 CLI | 1 CLI + 設定が重い | 1 CLI + 移行 | 1 パッケージ | 0 |
| staged 対応 | **なし**（ref / 作業ツリー比較） | なし | なし | なし | なし |
| 実行順 | グラフ順 | グラフ順 | グラフ順 | 依存順 | **アルファベット順・保証なし** |

npm workspaces の `--workspaces` は**キャッシュも affected も依存順も無い**（実測: 直列、個別合計と一致）。
turbo / nx / moon はこの穴を埋めるが、いずれも「作業ツリー基準」で、コミット時点の index を見る機能は無い。
つまり **runner を入れても R-01 は解決しない**。

### 3.4 実測で分かった落とし穴（設計に効く）

1. `vitest --changed` は未追跡ファイルがあると全実行に落ちる（このリポジトリでは常時）。テスト選択の単位は**パッケージ**にする。
2. `tsc`/`tsrs` にファイルリストを渡すと **tsconfig が無視される**。「変更ファイルだけ型検査」は不可、パッケージ単位で切る。
3. `oxfmt` は Markdown も整形する。ステージ全ファイルを渡すと docs で落ちる。対象は `packages/` に限定する。
4. `oxlint` は警告で exit 0。`--deny-warnings` を付けないとゲートにならない。
5. `oxlint` に非 JS ファイルだけを渡すと exit 1。パス選別は呼び出し側の責任。
6. `npm query '.workspace'` で影響グラフが取れる（追加依存ゼロ）。
7. `tsrs --incremental` は効くが、全体が 0.6 秒なので不要。
8. `knip --cache` は 0.5 → 0.35 秒。誤差。

## 4. 要件との突き合わせ（Must のみ）

| 要件 | 満たす仕組み | 備考 |
| --- | --- | --- |
| R-01 ステージ内容を検査 | lint-staged / lefthook / prek / hk の stash 機構 | 自前は危険。借りる |
| R-02 パッケージ判定 | `git diff --cached` + パス→パッケージ対応 | 20 行程度 |
| R-03 依存方向 | `npm query '.workspace'` の閉包、または turbo/nx/moon | npm だけで可 |
| R-04 対象外パス | runner の glob（lefthook/prek/hk）または自前のパス判定 | docs 71% の根拠 |
| R-05 全量条件 | 設定/lockfile を glob で拾い、当たれば全量 | 各 runner の glob で書ける |
| R-06 段階の独立実行 | runner のジョブ定義、または npm scripts の分割 | |
| R-07 速い検査だけ | 段階設計（下記） | |
| R-08 build を外す | pre-push / CI へ移動 | 唯一の検出機会は push/CI に残す |
| R-09 遅いテスト分離 | vitest の `projects` を分割（`workspace-slow` など） | 設定1か所で済む |
| R-10 失敗の可視化 | runner の出力 + 段階名 | |
| R-11 警告も失敗 | `oxlint --deny-warnings` | 実測で穴を確認 |
| R-12 定義を1か所 | `lefthook.yml` / `.pre-commit-config.yaml` / npm scripts | 自前なら1ファイルに集約 |
| R-13 設定の二重管理なし | 各ツールの設定はそのまま | |
| R-14 1コマンド導入 | `lefthook install` / `pre-commit install` / `prepare` | |
| R-15 nix 吸収 | hook 内で node の有無を判定し、案内か `nix develop --command` | |
| R-16 ローカル=CI | 同じ runner 定義を CI から呼ぶ | CI は 0041 |
| R-17 スキップ手段 | `SKIP=...` / `--no-verify` | |

## 5. 段階設計の案（数字は実測からの試算）

| 段階 | 走らせるもの | 対象 | 実測/試算 |
| --- | --- | --- | --- |
| pre-commit（docs のみ） | なし（「検査対象なし」と表示） | — | **0.1s** |
| pre-commit（web のみ） | lint, fmt, typecheck, test | web | **約 2.3s** |
| pre-commit（core 変更） | 同上（速い層） | 全パッケージ | **約 3s** |
| pre-push | 上記 + 遅いテスト + build | 全量 | 約 20s |
| CI | 全量 + 将来の E2E | 全量 | 0041 |

「速い層」の候補: `core` `store` `web` と `workspace` の `sandbox.test.ts`（合計 1.5〜1.9s）。
「遅い層」: `workspace.test.ts` `toctou.test.ts` `hardening.test.ts`（12.5s）と `agent.test.ts`（3.7s）。
分け方は `vitest.config.ts` の `projects` に `workspace-slow` / `agent-slow` を足すだけで表現できる。

## 6. 選択肢の比較と推奨

| | A: npm scripts + 自前セレクタ | B: lefthook + 自前セレクタ | C: turbo |
| --- | --- | --- | --- |
| 新規依存 | 0 | 1（npm/nixpkgs） | 1（CLI + turbo.json） |
| R-01（内容） | 自前（危険） | 借りる | 不可 |
| R-06（段階） | npm scripts | YAML のジョブ | turbo タスク |
| キャッシュ | なし | なし | あり |
| 設定の見通し | scripts が増える | 1ファイル | 1ファイル + 各 package |
| CI 移行 | 手作業 | 同じ定義を呼べる | 得意 |
| 学習コスト | 低 | 低 | 中 |

**推奨**: 第1段は「段階分割 + パッケージ単位の選別 + 遅い層の分離 + build を pre-push へ」。
この4つだけで 71% のコミットが 0.1 秒、残りも 3 秒前後になる。**runner の選択はその後**でよい。
第2段で lefthook（定義の1か所化・部分ステージの退避・並列）を入れ、CI とパッケージが増えたら
turbo の affected + cache を検討する。turbo は staged を見ないので、R-01 は lefthook / lint-staged 側に残る。

## 7. 未確認

1. Node 26 以外（Node 24）での研究側実測があり、テスト時間が 10.9s vs 12.9s、build が 5.1s vs 5.5s とずれる。本ドキュメントは Node 26 の値を使った。
2. lefthook の `git add -N` 問題（#1561）が現行 2.2.2 で解消されたか。
3. `core.hooksPath` 設定時に各 runner がどこへ hook を書くか（lefthook / prek は尊重、hk は Git 2.54+ の config-based hooks）。
4. turbo / nx / moon の cold→warm の倍率はベンダー主張のみで、このリポジトリでの実測は無い。
5. `--sinceLastRun` の実運用での安定性。
6. CI（0041）の設計。ここで決めた段階をそのまま使えるかは CI の形次第。

## 8. 出典

- lefthook: https://lefthook.dev/configuration/run/ ・ https://lefthook.dev/configuration/glob/ ・ https://github.com/evilmartians/lefthook/issues/1561
- lint-staged: https://github.com/lint-staged/lint-staged#readme （stashing / monorepo）
- pre-commit: https://pre-commit.com/ ・ https://github.com/pre-commit/pre-commit/blob/main/pre_commit/staged_files_only.py
- prek: https://prek.j178.dev/running-hooks/index.md ・ https://prek.j178.dev/monorepos/index.md
- hk: https://hk.jdx.dev/hooks.html ・ https://hk.jdx.dev/configuration.html
- overcommit: https://github.com/sds/overcommit#precommit （pre-commit の副作用禁止）
- Vitest: https://vitest.dev/config/changed ・ 実測（本リポジトリ）
- tsc/tsrs: https://www.typescriptlang.org/tsconfig/incremental ・ https://github.com/oxc-project/tsrs/blob/main/docs/USAGE.md
- oxlint/oxfmt: https://oxc.rs/docs/guide/usage/linter/cli ・ https://oxc.rs/docs/guide/usage/formatter/cli
- knip: https://knip.dev/reference/cli
- turbo: https://turborepo.dev/docs/reference/run
- nx: https://nx.dev/docs/features/ci-features/affected
- moon: https://moonrepo.dev/docs/commands/query/changed-files
- wireit: https://github.com/google/wireit#readme
- npm workspaces: https://docs.npmjs.com/cli/v11/using-npm/workspaces


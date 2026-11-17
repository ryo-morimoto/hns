# 0194: machine の sandbox・hide・env 純度（0147 から分割）

status: open
priority: now
design: agreed
design-ref: D095
depends-on: 0147
touches: packages/machine/, packages/machine/test/security/

## Goal

0147 のうち、環境依存で重い受入条件（bwrap・hide・実機確認・env 純度）を引き取る。
0147 は署名・パス封じ込め・上限に絞り、fixture で検証できる形のまま先に統合する。

## Acceptance criteria

- [ ] `exec` は bwrap 経由。sandbox が無ければ exec を出さない（fail closed）
- [ ] `~/.config/hns` と `.git` の書き込みを拒否し、`~/.config/hns` は読み取りも hide で隠す（0052 を起動時に配線）
- [ ] hide した `~/.config/hns` からデバイス鍵・cloudflared token が読めないことを実機で確認（bwrap 無しは SKIP）
- [ ] machine の env / process に provider 鍵・provider URL が無いことをテストする（harness 側は 0151）
- [ ] ROOT の同一性（`.hns/root.json`）を起動時に確認し、違えば拒否する
- [ ] `npm run check` が通り、独立レビューが PASS する

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | bwrap が無い環境 → exec → 実行せず拒否（SKIP ではなく拒否） | 高 | 受入1 |
| C2 | `~/.config/hns` を指すパス → read → 中身が返らない | 高 | 受入2・3 |
| C3 | `.git` 配下 → write → 拒否 | 高 | 受入2 |
| C4 | machine の env → provider 鍵と URL を探す → 無い | 高 | 受入4 |
| C5 | root の marker が違う → 起動 → 拒否 | 中 | 受入5 |
| C6 | 全変更 → `npm run check` → 通る | 高 | 受入6 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C3 | 境界値 + 実機 | integration | `packages/machine/test/security/`（bwrap 無しは明示 SKIP、C1 のみ拒否を固定） |
| T2 | C4 | 環境の固定 | unit | env の構築関数に対する assertion |
| T3 | C5 | 故障注入 | unit | marker の差し替え |
| T4 | C6 | ゲート | static / build | `nix develop --command npm run check` |

## Notes

- 分割の理由: 0147 の署名・パス・上限は fixture で検証でき、実 HTTP のテストも回せる。bwrap と hide は
  実行環境に依存し、SKIP が混ざるためレビューが長引く。先に 0147 を統合して 0148 / 0157 を開く。
- PoC: `work/poc/cf-harness/agent/server.mjs`。hide の配線は 0052 の内容をここで受ける。
- 0151 と合わせて「鍵が machine と harness のどちらにも無い」ことを示す。

## 調査メモ（0127 / sandbox レポート、2026-11-17）

- sandbox は `--ro-bind / /` の後に `--tmpfs <ROOT>` を置き、project root だけを bind する（兄弟 project を見せない）。`<projectRoot>/.hns` も隠す。
- hide は呼び出し側の任意リストではなく、**マシンの固定リスト**: `~/.config/hns`、`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.git-credentials`、`~/.netrc`、マシン鍵、cloudflared token。
- `--new-session` を足す（TIOCSTI）。
- egress は既定 `deny` か allowlist。少なくとも private range と `169.254.169.254` を遮断する。`inherit` はマシン設定に従う。
- checkpoint から `.hns`・secret・`.env` を除外する（0154 へ）。
- 出典: [agent-sandbox-designs.md](../research/agent-sandbox-designs.md) の R4–R8。

## Design（D095 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D095）。

### 前提

- 0147 landed: パス封じ込め・署名・上限は済み。**exec は sandbox が無い環境では出さない**（fail closed）。
- `packages/workspace/src/sandbox.ts` に bwrap の probe / 起動 / `--ro-bind / /` の骨格がある。`--tmpfs /tmp` は root が `/tmp/` の下にあるときだけ外す（root を隠さない）。
- 0127 の調査（R4–R8）と 0052 の hide を引き継ぐ。

### 決定 1: exec は bwrap のみ

- `findBwrap` で見つかり、`--version` が通り、probe が成功したときだけ `exec` を公開する。無ければ **拒否**（SKIP ではない）。
- `exec` の経路は `SandboxEnv` だけ。machine の op は health / stat / read / list に留め、exec は sandbox の後ろに置く。

### 決定 2: mount の形

- `--ro-bind / /` → `--tmpfs <ROOT>` → 親を `--dir` で作り、`--bind <projectRoot> <projectRoot>` → `--chdir <projectRoot>`。
- 兄弟 project は `--tmpfs <ROOT>` で見えない。`<projectRoot>/.hns` は `--tmpfs` で隠す。
- **`.git` は読み取りのみ**（docs/safety.md / docs/workspace.md）。`--bind <projectRoot> <projectRoot>` の後に `--ro-bind <projectRoot>/.git <projectRoot>/.git` を重ね、bash からも書き込めなくする（worktree で `.git` がファイルの場合はそのファイルを ro-bind）。
- `--tmpfs /tmp`（root が `/tmp/` の下なら外す）、`--unshare-pid` / `--unshare-ipc` / `--unshare-uts`、`--new-session`、`--die-with-parent`。

### 決定 3: hide は固定リスト

- `~/.config/hns`、`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.git-credentials`、`~/.netrc`、マシン鍵、cloudflared token。
- 呼び出し側から足せない。足りないものは issue で足す（実行時の任意指定にしない）。

### 決定 4: env の純度

- `--clearenv` の後に allowlist だけ: `PATH` / `LANG` / `TERM` / **`HOME`（root。0045 H-1 の既存決定）** / `TMPDIR=/tmp` / `GIT_OPTIONAL_LOCKS=0`（読み取りの git が index を書かない）。
- provider 鍵 / provider URL / control-plane 鍵 / device 鍵 / cloudflared token を入れない。

### 決定 5: egress

- `Project.egress = deny` → `--unshare-net`（外に出られない）。
- `inherit` → ホストの network をそのまま使う（既存の挙動）。
- `allowlist` → **v1 では deny に倒す**（proxy が無いのに allowlist を装わない）。allowlist の実装は別 issue。
- private range / `169.254.169.254` の遮断は、`inherit` ではホストの firewall に依存する（設計上の残リスクとして記録）。

### 決定 6: ROOT の同一性

- 起動時に `<projectRoot>/.hns/root.json` の marker と dev / ino を確認し、違えば拒否する。
- `.git` は **読み取りのみ**（U-02 は docs で解決済み）。agent の sandbox では commit しない。checkpoint / commit が要る場合は、sandbox の外の特権経路（0154 / 0156）で行う。

### 現行コードとの差分（sandbox.ts）

現行の `createSandboxEnv` は `--ro-bind / /` + `--bind <root> <root>` + `--dev` + `--proc` + `--die-with-parent`、`--clearenv` の後に PATH / HOME=root / LANG / LC_ALL / TERM / TZ、**呼び出し側の `options.hide` を tmpfs**、`--unshare-pid/ipc/uts`。

0194 で変える点:

- `options.hide` を廃止し、**machine の固定リスト**にする（呼び出し側から足せない）。既存テストの `hide` 指定は更新する。
- `HOME=root` は **0045 H-1 の既存決定**なので変えない（`.npmrc` / `.gitconfig` の汚染は許容）。`TMPDIR=/tmp` だけ足す。
- `--new-session`、`<projectRoot>/.git` の `--ro-bind`、`--unshare-net`（deny）を足す。
- machine の ROOT に複数 project がある場合に備え、`--tmpfs <ROOT>` → 親 `--dir` → `--bind <projectRoot> <projectRoot>` の順にする（現行は root を直接 bind）。
- env に `TMPDIR` と `GIT_OPTIONAL_LOCKS=0` を足す。
### 決定（D095）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | allowlist の egress | **決定（user）**: v1 は deny に倒す。proxy は別 issue | 0127 / 0038 | 2026-11-17 |
| U-02 | `.git` の書き込み | **決定（docs / user）**: `.git` は読み取りのみ。ro-bind で強制し、commit は agent の sandbox ではしない（0154 / 0156） | 0147 / 0194 | 2026-11-17 |
| U-03 | hide リスト | **決定（0127 / D080）**: 上記の固定リスト。呼び出し側から足せない | 0194 | 2026-11-17 |
| U-04 | HOME / TMPDIR | **決定（0045 H-1）**: HOME=root を維持。TMPDIR=/tmp。0052 の「home を分ける」は採らない | 0194 | 2026-11-17 |
| U-05 | bwrap の版 / フラグ | **決定（user）**: 実装時に `--new-session` / `--die-with-parent` の対応版を確認 | 0194 | 実装時 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | bwrap 無し → exec → 拒否（SKIP ではない） | 高 | 受入1 |
| C2 | `~/.config/hns` を指す read → 中身が返らない | 高 | 受入2・3 |
| C3 | 兄弟 project の path → read / list → 返らない | 高 | 0127 R4 |
| C4 | プロジェクト内の `.git` への write → 拒否。read / `git log` / `git show` は動く（`GIT_OPTIONAL_LOCKS=0`）。bash からも `.git/index` を書けない | 高 | U-02 |
| C5 | env → provider 鍵 / URL / cloudflared token を探す → 無い | 高 | 受入4 |
| C6 | egress deny → 外へ接続できない。inherit → ホストに従う | 高 | U-01 |
| C7 | root の marker が違う → 起動 → 拒否 | 中 | 受入5 |
| C8 | `--new-session` で TIOCSTI が効かない（可能な環境で） | 中 | R5 |
| C9 | `npm run check` | 高 | 受入6 |

## Log

- 2026-11-17: D095 で合意。U-01〜U-05 を決定し、`design: agreed` にした。U-03 は 0127、U-04 は 0045 の既存決定を参照。

## やらないこと

- 署名・nonce・時刻窓・パス封じ込め・上限（0147）。
- Windows / macOS の sandbox（0006 の範囲外）。
- machine の登録（0148）。

## Log

- 2026-11-11: 作成。0147 から環境依存の受入条件を分割。

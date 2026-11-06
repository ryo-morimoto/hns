# AGENTS.md

hns（複数マシンの AI Agent を、セルフホストの単一 UI から操作する）の作業規約。エージェントも人間も同じゲートを通る。

## 最初に読む

- `README.md` — やりたいこと（要件 1〜21）と現在地
- `ARCH.md` — アーキテクチャと不変条件（INV-01〜08）
- `docs/decisions.md` — 決定の履歴（追記のみ。覆すときは新しい D を足す）
- `docs/engineering.md` — スタック・型・AI slop 対策
- `docs/packages.md` — パッケージの責務と型の置き場所
- `work/BOARD.md` と `work/issues/` — 残作業（**残りは `work/` に置く**）

## 環境

Node は PATH に無い（Nix）。最初に一度:

```bash
NODE=$(ls -d /nix/store/*nodejs-24*/bin/node | head -1); export PATH=$(dirname "$NODE"):$PATH
export npm_config_cache=$PWD/.work/npm-cache
```

- パッケージマネージャは npm workspaces（`packages/*`）
- 秘密はリポジトリ外（`~/.config/hns/*.key`）。ログ・コミットに出さない
- Docker は無い。SQLite はインプロセスで使う

## コマンド

```bash
npm run check                 # oxlint → oxfmt --check → tsc → test → build
npm test -w @hns/core         # 単体
npm test -w @hns/store        # 実 SQLite を含む
npm run typecheck -w @hns/store
```

`work/poc/` の検証は別（各ディレクトリの `run.mjs`）。

## 型（type first）

- モデルは `packages/core/src/types.ts`。**型が正本**
- 境界は valibot。`v.GenericSchema<unknown, T>` で型に縛る（`packages/core/src/schemas.ts`、`packages/store/src/schemas.ts`）
- 外部入力（HTTP・DB・JSON・env）を `as` で型にしない。**parse する**
- `as` はやむを得ない場所だけ。必ず `// SAFETY: ...` を直前に書く（anti-slop が検査する）
- brand は `ProjectId` と `ConversationId` だけ
- `exactOptionalPropertyTypes` 有効。optional は `?: T | undefined` と書く
- namespace は使わない。モジュールで分ける

## パッケージ

- 依存は一方向: `web → core`、`server → agent / store / workspace → core`
- 型は不変条件を持つパッケージに置く。1パッケージしか使わない型を `core` に置かない
- `store` の Row（`archived: 0 | 1`、JSON 文字列）を外に出さない。`parse*` で公開型にする
- 各パッケージの `package.json` は pi に倣う（`exports` の `source` 条件、`tsconfig.build.json`、`files`）
- 依存を足すときは、なぜ要るかを decision に1行書く。exact pin

## テスト

- 永続化はモックしない。実 SQLite（`:memory:` か一時ファイル）で試す
- 失敗経路（不正入力・遷移違反・競合）をテストする
- `node --test` + 型ストリップ。パッケージ間の参照は `node --conditions=source`
- Chromium が要るテストは無ければ skip。`HNS_CHROME` で上書き

## 作業の流れ

1. `work/BOARD.md` で対象の issue を選ぶ
2. 型 → 実装 → テスト の順。契約が変わるなら先に型と schema
3. `npm run check` を通す
4. issue に結果を書き、`BOARD.md` を更新する。設計を変えたら `docs/decisions.md` に追記
5. コミットする（メッセージは `area: summary`）

**push しない。** 指示があるまでローカルだけ。

## やらないこと

- 使う予定のない抽象化・汎用層（YAGNI）
- スキーマを先に書いて型を後から作る（型が正本。schema は型に適合させる）
- `any`、握りつぶし、空 catch、issue 番号の無い TODO
- UI の作り込み（D011。最後に集中する）
- 生成物の手編集（生成ヘッダと再生成コマンドを守る）
- 人の指示だけで設計を変える。golden example（`docs/typescript.md`）と矛盾するなら、その場で言う

## コミット前チェック

- `npm run check` が通る
- 外部入力の parse がある
- union の `switch` が `never` で網羅されている
- 失敗が型に出ている（エラーコード・throw・Result のどれか）
- ドキュメント（issue / BOARD / decisions）が更新されている

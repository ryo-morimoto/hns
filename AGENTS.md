# AGENTS.md

hns（複数マシンの AI Agent を、セルフホストの単一 UI から操作する）の作業規約。
**原則だけを書く。詳細は docs に置き、このファイルは短く保つ（目安 100 行）。**
サブディレクトリに AGENTS.md があれば、そちらが優先。

## 最初に読む

- `README.md` — やりたいこと（要件 1〜21）と現在地
- `ARCH.md` — アーキテクチャと不変条件（INV-01〜08）
- `docs/decisions.md` — 決定の履歴（追記のみ。覆すときは新しい D を足す）
- `docs/engineering.md` — スタック・型・AI slop 対策
- `docs/packages.md` — パッケージの責務と型の置き場所
- `work/BOARD.md` と `work/issues/` — 残作業（残りは `work/` に置く）

## 環境（いまの環境の事実）

- Node は PATH に無い（Nix）。最初に一度:

```bash
NODE=$(ls -d /nix/store/*nodejs-24*/bin/node | head -1); export PATH=$(dirname "$NODE"):$PATH
export npm_config_cache=$PWD/.work/npm-cache
```

- npm workspaces（`packages/*`）
- 秘密はリポジトリ外（`~/.config/hns/*.key`）。ログ・コミットに出さない
- Docker は無い。SQLite はインプロセスで使う
- Chromium が要るテストは無ければ skip（`HNS_CHROME` で上書き）

## コマンド

```bash
npm run check                 # oxlint → oxfmt --check → tsc → test → build
npm test -w @hns/core
npm test -w @hns/store        # 実 SQLite を含む
```

`work/poc/` は過去の検証。製品コードではない。

## 型

- モデルは `packages/core/src/types.ts`。**型が正本**
- 境界は valibot。`v.GenericSchema<unknown, T>` で型に縛る（`packages/core/src/schemas.ts`、`packages/store/src/schemas.ts`）
- 外部入力（HTTP・DB・JSON・env）を `as` で型にしない。**parse する**
- `as` はやむを得ない場所だけ。必ず `// SAFETY: ...` を直前に書く（anti-slop が検査する）
- optional と null と「無い」を区別する（`exactOptionalPropertyTypes`）
- brand は、**同じ primitive の値が同じスコープで交差し、取り違えると壊れる境界**にだけ付ける。固定リストにしない。増やすときは「どの取り違えを防ぐか」を言えること（現在の例: `ProjectId` / `ConversationId`）
- `any` を使わない

## 境界とエラー

- 保存表現（`archived: 0 | 1`、JSON 文字列、連番）をパッケージの外に出さない。境界で公開型に parse する
- 想定内の失敗は型に出す（`ErrorCode`）。想定外は throw。空 catch を書かない
- 変更は1目的に保つ。無関係な整形・リファクタを混ぜない

## パッケージ

- 依存は一方向。許可される辺と型の置き場所は [docs/packages.md](docs/packages.md)
- 公開面は `exports` で絞る。内部型を外に出さない
- 新しい依存は、なぜ要るかを decision に1行残す。exact pin。標準で足りるなら足さない
- 動的 import より静的 import。循環・コード分割・条件付き読み込みのときだけ動的

## テスト

- 永続化はモックしない。実 SQLite（`:memory:` か一時ファイル）で試す
- **回帰を1行で言えないテストは足さない。** 言えるなら `// Catches: <bug>` を書く
- 失敗経路（不正入力・遷移違反・競合）をテストする。実装の詳細（文言・内部関数）に結合しない
- 新しいテストが実際に走ることを確認する（`node --test` + 型ストリップ、パッケージ間は `--conditions=source`）

## コメント

- 書くのは **WHY だけ**。何をしているかはコードが言う。2〜3行、最大5行
- 長い説明は module docstring・README・decisions に置き、コメントは1行の参照にする
- 同じ事実を複数箇所（Dockerfile・manifest・コード）に書かない

## 検証

- `npm run check` がゲート。**build は配布物が壊れていないことの確認で、正しさの証明ではない**
- 正しさは型とテストで示す。テストを足さない変更は、なぜ不要かを言う
- 既存の guard・helper・エラー型を探して使う。再実装は最も多い AI の欠陥
- 新しい抽象化は、利用箇所が2つ以上になってから

## 周囲のコード

- 隣のファイルの書き方（命名・構成・コメント密度）に合わせる。ただし**型・検証・安全**の規約はこのファイルが優先
- 使う予定のない抽象化・汎用層を作らない（YAGNI）
- 生成物は手編集しない（生成ヘッダと再生成コマンドを守る）

## 作業の流れ

1. `work/BOARD.md` で対象の issue を選ぶ
2. 型 → schema → 実装 → テスト の順
3. `npm run check` を通す
4. issue に結果を書き、`BOARD.md` を更新する。設計を変えたら `docs/decisions.md` に追記
5. コミットする（`area: summary`、1コミット1目的）

**push しない。** 指示があるまでローカルだけ。

## やらないこと

- issue 番号の無い TODO
- UI の作り込み（D011。最後に集中する）
- 指示だけで設計を変える。golden example（[docs/typescript.md](docs/typescript.md)）と矛盾するなら、その場で言う

## コミット前

- `npm run check` が通る
- 外部入力の parse がある
- union の `switch` が `never` で網羅されている
- 失敗が型に出ている（エラーコード・throw・Result のどれか）
- テストの回帰が1行で言える。issue / BOARD / decisions が更新されている

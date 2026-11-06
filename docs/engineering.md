# エンジニアリング方針: 技術スタック・構造・型・AI slop 対策

2026-11-07。PoC（`work/poc`）から製品コードへ移すための基準。

## 1. 技術スタック

| 層 | 選定 | 理由 | 捨てたもの |
| --- | --- | --- | --- |
| 言語 | TypeScript strict（`noUncheckedIndexedAccess`） | 境界が多い。型で守る | JS（PoC のまま） |
| 実行 | Node.js 26（`flake.nix` + nixpkgs-unstable で固定、D035） | 既存の pi-durable と同一。`node:sqlite` が使える | Bun（DB と sandbox の相性が未検証） |
| HTTP | Fastify 5 | SSE・テストが素直 | Express（検証が弱い）、Hono（未検証） |
| DB | SQLite（`node:sqlite`） | Durable と同じ。バックアップが簡単 | Postgres（今は不要） |
| UI | React 19 + Vite 8（Rolldown）+ TanStack Query 5 + Base UI | 最終段の UX を詰めやすい。状態の取り回しが明確。X の新 x.com（2026-11-04）と同じ土台 | 素の DOM（UI が育たない） |
| 型検査 | tsrs 0.22（D044） | tsc 互換の Rust 実装。型検査を速く保つ。emit は tsc のまま | tsc だけ（遅い） |
| エディタ | CodeMirror 6 | 軽い。diff は自前で持っている | Monaco（重い） |
| テスト | Vitest 5（unit / contract / repository / API）+ E2E（0043 で決める） | 1 runner で backend と将来の React を同じ規律に。型ストリップに依存しない | Jest（重い）、node:test（UI で二重化） |
| Lint / Format | **oxlint + oxfmt** + [anti-slop](https://github.com/dmmulroy/anti-slop)（vendored） | 速い。ルールをリポジトリ内で持って読み、自分たちで変えられる | ESLint + Prettier（遅い）、Biome（ルールの拡張性） |
| パッケージ | **npm workspaces**（`packages/*` + `apps/*`） | [pi](https://github.com/earendil-works/pi) と同じ構成。workspace 参照が素直 | pnpm（今のところ利点より設定が増える） |

テストの層・禁じ手・flaky の扱いは [testing.md](testing.md)。設計・型・API の規律は [design.md](design.md)。

## 2. コード構造

分割の提案と根拠は [packages.md](packages.md)。

```text
packages/
  core/       types.ts（モデル）
  workspace/  版・Journal・認可・イベント。./sandbox で exec 隔離
  agent/      Durable の組み立て、ツール、hooks、Model アダプタ
  store/      SQLite・migration・リポジトリ。./identity で認証と秘密
  server/     app。HTTP・SSE・Workflow・Automation、bin「hns」
  web/        React UI（最後）

各パッケージは [pi の packages](https://github.com/earendil-works/pi/tree/main/packages) に倣う。

- 独立した §package.json§（name / version / description / §exports§ の §source§ 条件 / §files§ / scripts）。
- §tsconfig.build.json§ で §dist§ にビルド。テストはパッケージ内の §test/§。
- §README.md§ と §CHANGELOG.md§。版は揃えて進める。
- ルートは workspaces で束ね、§check§ / §test§ / §build§ を一括で回す。
```

- 依存方向は **apps → packages** の一方向。`workspace` は pi-durable にだけ依存する。
- 逆流（`protocol` → `server` など）は `eslint-plugin-boundaries` で落とす。
- 1ファイル 400行、1関数 60行、分岐 10 を超えたら分割を検討する（ESLint で警告）。

## 3. type first + parse

**型が唯一の正本。** 境界は valibot で parse する。

1. `types.ts` にモデルを書く。
2. `schemas.ts` に valibot の schema を書き、`v.GenericSchema<unknown, T>` で型に縛る。合わなければコンパイルが落ちる。
3. HTTP の入口と DB の読み出しで `v.parse` する。
4. 型を変えたら、コンパイルが落ちる場所で追従する。

- スキーマは型の写しではなく、境界の検証。型と schema の不一致はコンパイルエラー。
- SSE のイベントも型で表す。

## 4. AI slop を防ぐ

### anti-slop（vendored）

[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) の汎用ルールを §tools/oxlint/anti-slop/§ に vendored している（MIT）。
npm 依存ではなく**コピー**として持つ。読んで、必要なら自分たちで変える（上流もそう勧めている）。

- 有効: 18 ルール（型のごまかし、低信号な配列操作、オブジェクト引数、§unknown§ の流入、§as§ の根拠要求など）。
- 無効: §require-readable-spacing§。oxfmt が空白を持つので、空行の要求が衝突するため。
- 更新: 上流の §src/§ を置き換え、差分を読む。ローカルの変更は §UPSTREAM.md§ に記録する。

### ゲート

**slop の定義**: 動くように見えるが、型と合わない・誰も使わない・根拠のない抽象化・重複した実装。

| 仕組み | 何を止めるか |
| --- | --- |
| `noUncheckedIndexedAccess` | 未検証の JSON、`any` の伝播 |
| anti-slop: `no-unknown-parameters`・`no-unsafe-dictionary-type`・`no-widen-then-assert`・`require-safety-comment-for-type-assertion` | 型を捨てる近道、根拠のない `as` |
| anti-slop: `no-object-parameters`・`no-array-filter-map`・`no-reduce-accumulator-copy`・`no-module-mocking` | 低信号な実装パターン |
| `knip` | 未使用の export・依存・ファイル |
| 依存の追加ルール | 「便利そう」で増える依存。追加は ADR 1枚と exact pin を要求 |
| 生成コードの明示 | 手で直される生成物（ヘッダに `generated` と再生成コマンド） |
| 小さな PR・1目的 | ついでのリファクタと機能追加の混在 |
| 変更ごとの「何を証明したか」 | テストが増えない変更、根拠のない最適化 |
| 未使用の抽象化の禁止 | 使う予定のない汎用層（YAGNI。増やすなら利用箇所を先に示す） |
| ドキュメントの同期 | 型・ADR・README の更新漏れ（リンク検査と更新日） |

- `TODO` は issue 番号を必須にする（`TODO(#1234): ...`）。
- `@ts-expect-error` は理由と issue を同じ行に書く。
- 例外・握りつぶしは「なぜ無視してよいか」をコメントで残す。
- エージェントが書いたコードも同じゲートを通す。レビューは [review.md](review.md) の手順（契約 → 振る舞い → 証拠）で行う。

## 5. 移行

PoC は残す（履歴）。製品コードは `apps` / `packages` に新しく置き、PoC から1機能ずつ移植する。
最初の縦切りは **protocol → server の health / state / chat**。UI は D043 で画面単位に前倒しする。
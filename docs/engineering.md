# エンジニアリング方針: 技術スタック・構造・契約・AI slop 対策

2026-11-07。PoC（`work/poc`）から製品コードへ移すための基準。

## 1. 技術スタック

| 層 | 選定 | 理由 | 捨てたもの |
| --- | --- | --- | --- |
| 言語 | TypeScript strict（`noUncheckedIndexedAccess`） | 境界が多い。型で契約を守る | JS（PoC のまま） |
| 実行 | Node.js 24（`.nix` / devenv で固定） | 既存の pi-durable と同一。`node:sqlite` が使える | Bun（DB と sandbox の相性が未検証） |
| HTTP | Fastify 5 + zod | schema 検証・SSE・テストが素直 | Express（検証が弱い）、Hono（DB/worker との相性未検証） |
| 検証・契約 | zod（`packages/protocol`） | 単一の正本から OpenAPI と型を作る | 手書き OpenAPI（乖離する） |
| DB | SQLite（`node:sqlite`） | Durable と同じ。バックアップが簡単 | Postgres（今は不要） |
| UI | React 19 + Vite + TanStack Query | 最終段の UX を詰めやすい。状態の取り回しが明確 | 素の DOM（UI が育たない） |
| エディタ | CodeMirror 6 | 軽い。diff は自前で持っている | Monaco（重い） |
| テスト | Vitest（unit / contract）+ Playwright（E2E） | 契約テストを速く回す | Jest（遅い） |
| Lint / Format | **oxlint + oxfmt** + [anti-slop](https://github.com/dmmulroy/anti-slop)（vendored） | 速い。ルールをリポジトリ内で持って読み、自分たちで変えられる | ESLint + Prettier（遅い）、Biome（ルールの拡張性） |
| パッケージ | **npm workspaces**（`packages/*` + `apps/*`） | [pi](https://github.com/earendil-works/pi) と同じ構成。workspace 参照が素直 | pnpm（今のところ利点より設定が増える） |

## 2. コード構造

分割の提案と根拠は [packages.md](packages.md)。

```text
packages/
  core/       types.ts（ドメイン語彙）+ contracts.ts（zod）+ OpenAPI
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

## 3. type first

**型が正本。** スキーマは型に適合することをコンパイラが検査する。

1. `packages/core/src/types.ts` にモデルを書く（Project・Conversation・Event・Metrics …）。
2. `validation.ts` に zod を書き、`z.ZodType<T>` として型に合わせる。合わなければコンパイルが落ちる。
3. OpenAPI は `validation.ts` から生成する。
4. サーバは境界で validation を通す。契約テストは**実サーバ**のレスポンスを検証する。
5. UI は `types.ts` の型だけを使う（レスポンス型を手書きしない）。

- 型の変更が先。スキーマは型に追随する（drift はコンパイルエラーになる）。
- スキーマを先に書かない。型に無いものを検証しない。
- SSE のイベントも型とスキーマを持つ。
- 小さな道具（`json()` など）は型で表現し、`as` は SAFETY コメント付きで最小限にする。

## 4. AI slop を防ぐ

### anti-slop（vendored）

[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) の汎用ルールを §tools/oxlint/anti-slop/§ に vendored している（MIT）。
npm 依存ではなく**コピー**として持つ。読んで、必要なら自分たちで変える（上流もそう勧めている）。

- 有効: 18 ルール（型のごまかし、低信号な配列操作、オブジェクト引数、§unknown§ の流入、§as§ の根拠要求など）。
- 無効: §require-readable-spacing§。oxfmt が空白を持つので、空行の要求が衝突するため。
- 更新: 上流の §src/§ を置き換え、差分を読む。ローカルの変更は §UPSTREAM.md§ に記録する。

### ゲート

**slop の定義**: 動くように見えるが、契約と合わない・誰も使わない・根拠のない抽象化・重複した実装。

| 仕組み | 何を止めるか |
| --- | --- |
| 契約テスト（実サーバ） | 実装と契約の乖離、想像で書いたレスポンス |
| `noUncheckedIndexedAccess` と境界の zod | 未検証の JSON、`any` の伝播 |
| anti-slop: `no-unknown-parameters`・`no-unsafe-dictionary-type`・`no-widen-then-assert`・`require-safety-comment-for-type-assertion` | 型を捨てる近道、根拠のない `as` |
| anti-slop: `no-object-parameters`・`no-array-filter-map`・`no-reduce-accumulator-copy`・`no-module-mocking` | 低信号な実装パターン |
| `knip` | 未使用の export・依存・ファイル |
| 依存の追加ルール | 「便利そう」で増える依存。追加は ADR 1枚と exact pin を要求 |
| 生成コードの明示 | 手で直される生成物（ヘッダに `generated` と再生成コマンド） |
| 小さな PR・1目的 | ついでのリファクタと機能追加の混在 |
| 変更ごとの「何を証明したか」 | テストが増えない変更、根拠のない最適化 |
| 未使用の抽象化の禁止 | 使う予定のない汎用層（YAGNI。増やすなら利用箇所を先に示す） |
| ドキュメントの同期 | 契約・ADR・README の更新漏れ（リンク検査と更新日） |

- `TODO` は issue 番号を必須にする（`TODO(#1234): ...`）。
- `@ts-expect-error` は理由と issue を同じ行に書く。
- 例外・握りつぶしは「なぜ無視してよいか」をコメントで残す。
- エージェントが書いたコードも同じゲートを通す。レビューは「契約・テスト・依存」を先に見る。

## 5. 移行

PoC は残す（履歴）。製品コードは `apps` / `packages` に新しく置き、PoC から1機能ずつ移植する。
最初の縦切りは **protocol → server の health / state / chat**。UI は最後（D011）。
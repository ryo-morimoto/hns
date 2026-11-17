# L6 のシステムデザイン: docs の情報アーキテクチャ

2026-11-18 / lead。リファクタの最終束（context と docs）を「追加パッチ」ではなく**設計**として直す。
対象: `docs/` 4,799 行（`decisions.md` 1,543 / `capability.md` 479 / `durability.md` 281 …）、`AGENTS.md` 202 行、`work/BOARD.md` 461 行、issue の二重 Design。計測は `work/reviews/2026-11-18-measurements.md`。

## 1. 問題（計測から）

- 1 レーンが着手前に読む量は **1,201 行 / 約 48k token**（AGENTS 202 + testing 195 + parallel-change 161 + issue 平均 172 + Result 10 + BOARD 461）。規範の 356 行が固定費。
- モデル生成がサブエージェントの wall の **44〜52%**。入力の cacheRead は lane 469M / reviewer 127M token。**読む量がそのまま時間**。
- issue の平均 172 行（最大 280）。**設計が二重**（0149 は「Design（D078）」76 行と「Design（実装）」56 行が併存）。
- `decisions.md` 1,543 行・107 決定。参照は 12 レーンで 540 回。**探すコスト**が読むコストより大きい。`D094` が 2 つある。

## 2. 情報の種類（いま混ざっているもの）

| 種類 | 変化の速さ | 誰のための文書か | いまの置き場 |
| --- | --- | --- | --- |
| **不変条件（invariant）** | ほぼ変わらない | 実装者・レビュアー・エージェント | AGENTS / durability / observability に散在 |
| **契約（contract）** | 設計変更時 | 呼び出し側 | packages README / TSDoc / durability に散在 |
| **規範（procedure）** | 稀 | レーンを回すエージェント | testing / parallel-change / process / AGENTS に重複 |
| **決定の履歴（decision log）** | 追記のみ | 人間（なぜ） | decisions.md（1,543 行） |
| **作業の状態（work state）** | 毎日 | lead・人 | BOARD / LANES / issues |

問題は「4 と 5 が 1〜3 と同じ場所に置かれ、全体を読ませている」こと。**決定ログは索引（1 行）と本文（必要時だけ）に分け、作業状態は 1 画面に絞り、規範は 1 か所に集める**のが設計。

## 3. 目標の構造

```text
AGENTS.md                     … ルーティング（< 120 行）。何を読むかだけを決める
├── docs/invariants.md        … INV-01..13 の唯一の台帳（durability から移す。定義・根拠・テストの対応）
├── docs/architecture.md      … モジュール境界（パッケージの辺・型の置き場・面の所有者）を 1 枚に
├── docs/contracts/            … 面ごとの契約（REST / GraphQL / WS / machine / journal / index）を 1 面 1 ファイル
│   ├── failures.md           … code → status → 面 の表（L3 の表を正本化）
│   ├── workspace.md          … 版・absent・checkpoint・restore
│   ├── journal.md            … intent/outcome/audit/watermark
│   └── ...
├── docs/procedures/          … 規範（testing / parallel-change / process / review）を 1 か所に。AGENTS からは要約とリンク
├── docs/decisions/            … 1 決定 1 ファイル（番号・日付・決めたこと・前提が変わる条件）。索引は生成
└── work/BOARD.md             … now だけ（< 80 行）。next は issues から導出
```

規則（境界）:

1. **AGENTS には規範を書かない**。ルーティングと「着手は now だけ」「レビューは PASS まで」など 5 行の不変条件だけ。
2. **不変条件は `docs/invariants.md` が唯一の台帳**。durability / workspace / observability は参照だけ。欠番（INV-01/02/07/08/12）は定義するか参照を消す。
3. **契約は面ごとに 1 ファイル**。コードの TSDoc は同じ内容を短く持ち、契約ファイルを指す。L3 の status 表・L2 の語彙はここが正本。
4. **決定は 1 決定 1 ファイル**。本文から他決定を参照するときは `DNNN` リンク。索引（`docs/decisions/README.md`）は見出しだけで生成。**追記のみ・番号は振り直さない**（D094 の重複は「D094a」「D094b」ではなく、後着を次の空き番号にし、参照に注記）。
5. **作業状態は BOARD が唯一**。`now`（≤3）と「止まっている理由」だけ。`next` は issue のヘッダから導出し、BOARD に列挙しない。
6. **issue は 3 節だけ**: Goal / Acceptance / Log。設計は issue に書かない（契約ファイルと決定へ）。Result は 1 画面（≤ 20 行）。

## 4. 移行（1 レーン 1 目的、main を緑に保つ）

| 段 | 変更 | 受入（数値） |
| --- | --- | --- |
| M1 | `docs/invariants.md` を新設し、durability / workspace / observability の INV を移す。欠番を定義。 | 参照切れ 0、INV の定義 13 件 |
| M2 | `docs/contracts/` を新設し、failures / workspace / journal / index / obs を 1 面 1 ファイルに。L3 の表を正本化。 | 面ごとの契約 5 本、重複記述 0 |
| M3 | `docs/decisions/` へ 1 決定 1 ファイル（107 件）。索引を生成、D094 の重複を解決。 | `decisions.md` 0 行、ファイル 107、索引が自動生成 |
| M4 | 規範を `docs/procedures/` へ集約し、AGENTS を 120 行以下に。 | AGENTS ≤ 120 行、規範の重複 0 |
| M5 | BOARD を `now` だけに。issue の 3 節化と Result の型。 | BOARD ≤ 80 行、レーン固定読解 ≤ 640 行 |
| M6 | `docs/packages.md` / `web-client-nfr` / `limits` / `observability` の実装とのずれを直す。 | 実装との diff 0（L2 の grep と L4 の削除を反映） |

順番は M1 → M2 → M4 → M3 → M5 → M6（決定の分割は参照が増えるので後、BOARD は最後に一度だけ）。各段は独立に main へ載せられる。

## 5. この設計で確認すること（受入）

- 1 レーンの固定読解: **1,201 → 640 行以下**（計測方法は measurements と同じ）。
- AGENTS の行数 ≤ 120、BOARD ≤ 80、issue の Design 節 0。
- `docs/` の総行数は増えない（移動と圧縮で、契約と不変条件は短く）。
- 参照切れ（`docs/*.md` のリンクと `DNNN`）0。
- 決定の追記のみの規約（既存の決定文を書き換えない）が守られていること。

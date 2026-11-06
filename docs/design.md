# 設計

2026-11-07 / D042。設計判断の根拠と、設計時に守ることを領域ごとに置く。**設計の前に読み、レビューの前に該当領域だけ読む。**
原則は AGENTS.md、レビューの手順は [review.md](review.md)。ここは「条件 → 命令 → 補足 → Ref」の形で、判断を実行できる形にしたもの。

各項目の **条件**は「この形を見たら」、**命令**は「どうする」、**補足**は理由と例外、**Ref** は出典。
原典と hns の統合判断（2回で抽象化、blocking の定義、優先度を作らない）は、補足に `hns:` と書いて区別する。
矛盾したときの優先順は、AGENTS.md（常時の原則）→ ここ（設計時の展開）→ [review.md](review.md)（検査）。
テストは [testing.md](testing.md)、観測は [observability.md](observability.md)、認証の詳細は [auth.md](auth.md)。ここは設計の判断だけを置く。

## 読む順

1. [abstraction.md](design/abstraction.md) — 作るか作らないか、抽象化、共通化
2. [boundary.md](design/boundary.md) — モジュール、責務、公開面、依存
3. [contract.md](design/contract.md) — 型、境界、エラー、互換
4. [data.md](design/data.md) — 永続化、並行、上限、移行
5. [http.md](design/http.md) — HTTP API
6. [security.md](design/security.md) — 認可、秘密、sandbox

## 対象別の入口

| 作るもの | 先に読む |
| --- | --- |
| 新しい機能・抽象化 | abstraction.md（今必要か → 取り返せるか → 誤抽象） |
| パッケージ・モジュールの分割 | boundary.md（何を隠すか → 深さ → 依存） |
| 公開 API・型・エラー | contract.md（境界 → 不正状態 → 契約） |
| 保存形式・journal・再送 | data.md（冪等 → 原子性 → 互換） |
| HTTP のルート・一覧・エラー | http.md（ページネーション → safe/idempotent → problem details） |
| 認可・秘密・sandbox | security.md（OWASP → PAGNI → fail closed） |

## 進め方

1. **今必要か**を決める（abstraction）。必要でなければ作らず、issue に理由を残す。
2. **何を隠すか**を決める（boundary）。変わる判断を1箇所に閉じる。
3. **公開面と契約**を決める（contract）。境界で parse し、失敗を型で返す。
4. **状態と上限**を決める（data）。冪等・原子性・版・上限・移行。
5. **入口**を決める（http / security）。ページネーション、冪等、エラー、認可。
6. **利用側から書く**。典型的な使い方を先に書き、自然でなければ設計を直す。

## 注意

- **[Rule of Three](https://martinfowler.com/books/refactoring.html) は法則ではない。** hns: 抽象化は2つの利用箇所でよいが、共通化の検討は3回目。混ぜない。
- **[Beck Design Rules](https://martinfowler.com/bliki/BeckDesignRules.html) は二次資料**（Fowler による Beck 規則の整理）。
  [designing with types](https://fsharpforfunandprofit.com/series/designing-with-types/) は Minsky の言い回しの解説。
  [KISS](https://en.wikipedia.org/wiki/KISS_principle) は標語で単一原典がない。
- **[Liskov & Wing 1994](https://dl.acm.org/doi/10.1145/197320.197383)** は API 契約と SOLID の両方で引く（同じ原典）。
- **優先度は文献にない。** hns: P0/P1/P2 は作らず、重大 / 高 / 中 / 低 と blocking の定義（[review.md](review.md)）で決める。
- **PAGNI は機密を無条件に保存しない。** hns: 何を残すか、アクセス制御、保存期間は [security.md](design/security.md) で決める。

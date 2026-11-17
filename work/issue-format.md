## issue の型（Goal / Acceptance / Log）

2026-11-18 / L6 M5。issue は**3 節だけ**。設計は issue に書かない（[contracts](../docs/contracts/README.md) と [decisions](../docs/decisions.md) へ）。

```markdown
# NNNN: 一行の成果

status: open | in-progress | done
priority: now | next | later | parked
design: agreed | pending
design-ref: docs/contracts/<面>.md か DNNN
depends-on: NNNN, NNNN
touches: 変更してよいパス（ディレクトリ可）

## Goal

何ができるようになるか（2〜4 行）。なぜかを 1 行。

## Acceptance

- [ ] 観測できる条件（数値・回数・status）。テストで固定できる形で書く。
- [ ] `npm run check` が通る

## Log

- YYYY-MM-DD: 何を決め、何をしたか（1 行ずつ）
```

### 規則

- **設計は書かない**。契約の変更は `docs/contracts/`、判断は `docs/decisions.md`、設計の合意は `design-ref` で指す。issue に「Design」節が残っている既存分は、契約・決定に移してから削る。
- **Acceptance は観測できる形**。「正しく動く」ではなく「status が 400」「行数が 10 以下」「EXPLAIN が索引を使う」。
- **Log は追記のみ**。結果は `## Result` ではなく、issue の最後に 20 行以内で書く（verdict / reviewer / HEAD / 根拠 / 非 blocking の follow-up）。
- **番号は 1 回だけ使う**。衝突したら後着を次の空き番号にし、参照に注記する。
- 1 issue = 1 branch = 1 worktree。`touches` の外を触るなら、先に issue を直す。

### BOARD の型

`work/BOARD.md` は**作業状態の唯一の置き場**で、次だけを持つ。

1. `now`（≤ 3 行）: issue / 一言 / 依存の状態
2. 止まっている理由（1 行ずつ）
3. 次の昇格の候補（`next` から lead が選ぶ。**全件を列挙しない**）

`next` / `later` / `parked` の件数は issue のヘッダから数える（BOARD に一覧を書かない）。

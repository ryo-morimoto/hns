# レビュー（実装後）

2026-11-07 / D040・D041。`npm run check` は「壊れていない」ことの証明ではない。独立した目で、変更が契約を
安全に満たすかを確かめる。原則は [AGENTS.md](../AGENTS.md) の Review。進行（対象・渡すもの・直し方・記録）は
[process.md](review/process.md)。**reviewer は process.md と eval.md を読まない**（author 用と、観点の変更時だけ）。

不変条件は条件で分ける。変更が触るものだけ読み、触っていない領域は読まない（common は常に）。

| 条件 | 不変条件 |
| --- | --- |
| 常に | [common.md](review/common.md) — 失敗の形・型、schema、docs の主張、テスト、抽象、修正そのもの |
| パス・コマンド・秘密・sandbox・認可・既定値・降格 | [security.md](review/security.md) |
| 永続化・書込・再送・並行・上限 | [persistence.md](review/persistence.md) |
| wire / schema / signature / イベント名 / 互換 | [contracts.md](review/contracts.md) |
| 画面・操作・状態・文言（UI/UX） | [ux.md](review/ux.md) |
| 観点を足す・削るときだけ | [eval.md](review/eval.md) |

観点の根拠は [design.md](design.md) の各項目（原典リンク付き。設計時の命令もそこにある）。迷ったら diff のファイル名で決める（`sandbox` → security、`journal` / `store` / `migrate` → persistence、
`http-schemas` / `core/types` → contracts）。

## 手順

1. 契約を再構成する。依頼と受入条件を読み直し、変えるもの・変えないものを決める。記憶ではなく diff を見る。
2. 振る舞いを疑う。境界・失敗・並行・認可・互換。ハッピーパスで出ない失敗を探す。
3. 証拠を要求する。条件・経路・期待・実際を言えるものだけ。実行か経路で示す。blocking の前に反証を1回試す。
4. 範囲を守る。新規・既存は diff と `git blame` / `git log -S`。古い欠陥でも到達経路が増えたら新規。
   無関係な refactor を要求せず、契約を戻す最小の修正を求める。
5. 検証を検証する。`nix develop` 内で `npm run check`。壊したら落ちるかを問い、確認したこと・していないことを書く。
6. ループを閉じる。blocking を author に返し、修正 diff を再 review。blocking が無くても残件と未確認事項を書く。

## 判定

| 判定 | 意味 |
| --- | --- |
| PASS | blocking 無し。未確認事項と残件を列挙 |
| FAIL | blocking あり（再現手順と観測、または成立する経路） |
| BLOCKED | HEAD・受入条件・環境・依存が揃わず確認できない。自己確認で置き換えない |

**blocking** = この変更で生まれた 重大・高・中。前からある問題は diff がその経路を悪化させた場合だけ（他は issue）。
低だけが blocking にならない。
指摘 = `重大度 / file:line / 観測（実行結果・型・テスト、または経路） / 修正案 / blocking か`。
重大度は 重大 = 任意ファイル・秘密・停止、高 = 定常運用で壊れる・漏れる、中 = 条件付きの誤動作・契約不一致、低 = 保守性。
同じ原因は1つにまとめる（件数は signal ではない）。

## reviewer に渡す文

```text
docs/review.md を読み、常に common.md、変更が触る領域の不変条件ファイルだけ読んでください。
<base>..HEAD を独立レビューし、author の説明は正解として扱わず diff と実行結果で確かめること。
判定と blocking は review.md のとおり。今回の変更と無関係な既存の問題は issue 候補として分けること。
指摘は「重大度 / file:line / 観測（実行結果か経路） / 修正案 / blocking か」で。最後に PASS / FAIL / BLOCKED と未確認事項を書く。
```

出典: D040 と 0045 の Log。

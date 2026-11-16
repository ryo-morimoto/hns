# 0039: 観測の製品化

後継: 0162（events / metrics）+ 0163（usage）。

status: superseded
depends-on: 0145, 0146
touches: packages/store, packages/server

## Goal

イベントログとメトリクスを製品の API と UI で使えるようにする。

## Acceptance criteria

- [ ] events を store に保存し /api/events・/api/metrics を提供
- [ ] リクエスト ID と HTTP・会話・ツール・Workflow の記録
- [ ] body・header・token を記録しない
- [ ] 保持期間を設定できる

## Design（案・レビュー中）

2026-11-17 / レビュー前の案。承認後に DNNN を追記し、superseded にする。

### 結論: 0162 / 0163 に吸収し、superseded にする

根拠:

- 0162 の Notes が「0039 の製品化はここに含める」と明記している。
- 0162 の AC に events の語彙・相関 ID・本文/ヘッダ/トークンを残さない・保持期間と量の上限がある。
- docs/observability.md が events の語彙、`/api/events`・`/api/metrics`、30日保持をすでに定義している（0162 の design-ref）。
- 0163 が usage_log とコスト上限、0123 が保持期間の設定、0107 が観測の UI を持つ。
- 0039 の AC は上記に全部ある。同じことを2つの issue に持つと、片方だけ直る事故になる。

残る差分:

- **面の owner**: D077 は運用（metrics / events / usage）を 0039 にした。superseded にするので、**0162（events / metrics）+ 0163（usage）** に移す。D079 で記録する。
- 0039 の「保持期間を設定できる」は 0123（設定）+ 0162（prune）に分かれる。

承認後にやること:

- 0039 を `status: superseded` にし、先頭に「後継: 0162 / 0163」を書く。
- 0123 / 0107 の `depends-on` の 0039 を 0162 に直す。
- 0162 の AC に「`/api/events`・`/api/metrics` を提供する」を足す（docs にあるが AC に無い）。
- BOARD の設計待ちから外す（13 → 12）。

### 未確定

| ID | 論点 | 仮説 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 面を 0162 に持たせるか | 0162（`server/src/obs/` を持つ） | 0162 / D077 | このレビュー |
| U-02 | usage を 0163 に寄せるか | 0163 | 0163 / 0123 | このレビュー |
| U-03 | 保持期間の設定を 0123 に置くか | 0123 | 0123 / 0162 | このレビュー |

### テスト条件

なし（コードを変えない。docs と依存の整合だけ）。実装の受入は 0162 / 0163 が持つ。

## Log

- 2026-11-17: superseded（D082）。0162（events / metrics）+ 0163（usage）に吸収した。


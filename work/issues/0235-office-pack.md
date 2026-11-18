# 0235: Office エンジン（ibisOffice）の pack を同梱する

status: open
priority: now
design: agreed
design-ref: D102, docs/office.md
depends-on: —
touches: tools/office-pack/, tools/deploy/, docs/office.md, README.md, .gitignore

## 環境の前提（lead の調査、2026-11-19）

- **上流は取得できる**: `https://github.com/ibisjp/ibis-office/releases/download/v0.8.7/ibisOffice-0.8.7-Linux.AppImage` は 302 → 200 で **51,472,144 bytes**（スパイクの README と一致）。**この環境から GitHub に届く**（npm registry も届く）。
- **実行時依存はこの環境にある**: X11 3 点と mesa/lavapipe は `/nix/store` にある（`0194` の bwrap 経路が使っている）。**フォントは pack に同梱**（システムに依存しない）。
- したがって **pack の生成（C1 / C5・T3 の 2 回実行で同じ sha256）は CI で回せる**。**C2 / C3 / C4 の故障注入も回せる**（pack を直接 CLI で叩く）。**machine は使わない**（0236）。

## Intent

エンジンを「入っている前提」にせず、再現可能に同梱する。AGPL の履行もここで閉じる。
pack の中身と起動条件が決まらないと machine の実装（0236）が動かない。

## Goal

`tools/office-pack/` に、同じ手順で再生成できる pack（バイナリ・フォント・X11・Vulkan・manifest・法務ファイル）が置かれ、
machine がそれを読んで `preview` / `render` / `convert` を実行できる。AGPL の 4 点が配布物に含まれる。

## Acceptance criteria

- [ ] `tools/office-pack/build.sh` が版を固定して pack を作る（ibisOffice v0.8.7、sha256 を検証）
- [ ] `manifest.json` の `capabilities.operations` は **preview / render / convert のみ**（sidecar の op は 0242 が足す）
- [ ] フォント（IPAexGothic / Noto Sans JP）と `fonts.conf`、X11 3 点、mesa lavapipe + vulkan-loader が入る
- [ ] pack の CLI スモーク（`--export pdf` と `--export png` が 1 文書で成功）が CI で回る
- [ ] AGPL の 4 点（LICENSE / NOTICE / SOURCE.md / About 表示の文言）が配布物に含まれる
- [ ] README に「pack の入れ方」「sandbox から見えるパス（ro bind）」「失敗時の見え方」がある
- [ ] `.gitignore` で pack を git に入れない

## テスト条件

- C1: build.sh → manifest の sha256 と実ファイルが一致
- C2: バイナリの sha256 を 1 バイト変える → 起動しない
- C3: フォントを外す → PDF は出るが `missingFonts` に載る（黙って代替しない）
- C4: Vulkan を外す → PNG が失敗し、PDF は成功する（能力差として manifest と結果に出る）
- C5: 配布物に LICENSE / NOTICE / SOURCE.md が無い → gate が落ちる

## テスト設計

- T1: C1/C2/C5 → 故障注入 + 静的検査 → integration / gate
- T2: C3/C4 → 環境の欠落 → integration（pack を直接 CLI で叩く。machine は使わない）
- T3: 版の固定 → build.sh を 2 回実行して同じ sha256 → integration

## Problem / context

スパイクで、`ibisOffice` は単体では動かないことが分かっている。X11 の 3 ライブラリ・CJK フォント + fontconfig・
ソフトウェア Vulkan（PNG 用）が必要で、どれが欠けても失敗の見え方が違う。ここを pack に閉じないと、
利用者の環境差がそのままサポートになる。AGPL は「同梱して守る」（D102）と決めたので法務ファイルも pack の一部。

## Users and use cases

- 運用者: pack を入れるだけで有効になる。何が足りないかは `officeEngine` で分かる。
- 開発者: pack を作り直せる（版・sha256・フォントの出所がスクリプトにある）。
- 法務/サポート: 配布物に何が入っているかを manifest で説明できる。

## Non-goals

- エンジンの実行（0236）・sidecar（0242）。
- LibreOffice の同梱（D102）。
- 自動アップデート。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | リポジトリ内のスクリプトで pack を作り、配布物に同梱 | 再現可能・AGPL を 1 か所で履行 | 配布物が重い（git には入れない） | 低 | 中 |
| B | 利用者が自分で入れる | リポジトリが軽い | 環境差がサポートになる。AGPL が利用者任せ | 高 | 小 |
| C | 別リポジトリで配布 | 分離できる | 同期の手間、CI が 2 つ | 中 | 中 |
| Do nothing | 前提にする | すぐ書ける | 「動かない」の原因が分からない | 高 | 小 |

## Recommendation

A。D102（同梱して AGPL を守る）と、スパイクで分かった依存物を 1 か所に閉じる。

## Design: guide-level

```bash
tools/office-pack/build.sh     # 版を固定して pack を作る（展開 127 MB + fonts + mesa ≈ 200 MB）
tools/office-pack/verify.sh    # manifest の sha256 を検証
```

失敗時は `officeEngine` が union（`OfficeEngineUnavailable{reason}`）で返す。

## Design: reference-level

manifest の形は [docs/office.md](../docs/office.md) §11。pack は machine の ROOT の外に置き、
office 実行時だけ **ro bind** する（0236 / 0194 の sandbox 設計）。

## Invariants and failure modes

- pack の版と manifest の版が違う → 起動しない（fail closed）。
- 依存物の欠落は「部分的に動く」ことを許し、能力として manifest と結果に出す。
- 法務ファイルが欠けたら配布 gate で落とす。

## Cross-cutting concerns

- security: バイナリの sha256 を manifest で固定。署名は将来。
- cost: 配布物 +200 MB。git は +0。
- compliance: AGPL の 4 点。SOURCE.md は固定版の取得手順 + sha256。
- operability: 失敗理由を `officeEngine` で返す。

## Compatibility, migration, rollback

pack を消せば機能が無効になるだけ。ロールバックは版を戻す。

## Test plan

integration（build / verify / CLI smoke）と gate（法務ファイルの存在）。CI では pack をキャッシュする。

## Rollout and graduation

開発環境で作り、配布物へ。`officeEngine` が available になれば Phase 0 の前提が満たされる。

## Notes

- 依存物の根拠: [ibisoffice-spike](../work/research/ibisoffice-spike/README.md)（S12/S12b/S17）。
- 決定: D102。

## 未確定

- U-01: pack の展開先（`<install>/office-pack` か XDG_DATA_HOME か）/ 仮説: `<install>/office-pack` / 影響: 0236 の探索順 / 責任者: user / トリガー: 0236 の設計時。

## やらないこと

- エンジンの改造・パッチ、自動アップデート。
- Windows / macOS の pack。
- sidecar の op（0242）。

## Log

- 2026-11-17: 作成。
- 2026-11-17: 独立レビュー 1 回目を受け、capabilities を 3 op に限定、machine 依存のテストを CLI 直叩きへ、touches を補正（U-01 の pack 展開先は残る）。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

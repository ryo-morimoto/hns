# 0054: 同名ファイルの差し替え窓（TOCTOU の残り）

status: done
depends-on: 0005
touches: packages/workspace, docs/workspace.md, docs/safety.md

## Goal

helper が対象を hash してから rename するまでの間に、同じディレクトリの同名ファイルを差し替えられると
CAS が破れる。親の差し替えは dirfd で閉じたが、この窓は残っている。閉じるか、許容すると決めて
docs に書く。

## Acceptance criteria

- [x] `renameat2(RENAME_EXCHANGE)` で temp と対象を交換し、交換後の旧対象を hash して expected と
      比べる方式を評価する（Node に syscall が無いため、native helper か外部コマンドが要る）
- [x] 実装する / 許容する を決め、docs/workspace.md と docs/safety.md に反映する（**許容** を選んだ）
- [x] 実装する場合: カーネル非対応時のフォールバック（checks）と fail-closed の判断を書く（実装しないため対象外。
      docs には `checks` へ落とさない方針だけ書いた）
- [x] 差し替えを再現する回帰テストを足す（実装する場合）（実装しないため対象外）

## Notes

- 現在の helper は親を dirfd で固定するが、最終コンポーネントの CAS は
  「hash → rename」の2手であり、原子的ではない。
- Node の `fs.rename` では compare-and-rename ができない。native helper を足すと配布（0040）が増える。
- packages/workspace を触るので 0053 / 0055 と直列。

## やらないこと

- `openat2(RESOLVE_BENEATH)` だけで閉じる案（0005 で棄却済み）。
- macOS / Windows の実装。

## Log

- 2026-11-07: 作成（0045 の M-4 で「残る」と書いた窓）。
- 2026-11-07: 評価して **許容** を選び、docs/workspace.md と docs/safety.md に反映（f7e98a6）。
- 2026-11-07: 独立 review（toctou-review）FAIL（blocking 2: `checks` の親の窓を「影響なし」に含めた /
  renameat2 非対応時に `checks` へ落とす spec）。dirfd と checks を分けて修正し（d9fa963）、再 review PASS。
  low 3件も修正（2b1ba96）して再 review PASS。

## Result

- **許容する** と決めた（v0.1。実装しない）。
- 評価: Node 26 の `fs` は `renameat2` を公開しない（`fs.constants` に `RENAME_*` が無く、`fs.rename` は
  flags を取らない）。replace の CAS を閉じるには native addon か同梱バイナリが要り、配布（0040）とセットになる。
  absent の作成は `link(2)`（`fs.link`）で Node だけでも原子的にでき、`EEXIST` を conflict にできる。
  EXCHANGE 後に旧対象を hash する案は、不一致時の交換返しが原子的でない。
- 窓の影響（dirfd 経路）: hash と rename の間に同名を差し替えると、差し替えた側の内容が失われる（lost update）。
  書き込みは root 内の temp から置換され、root の外・秘密・可用性には影響しない。
  `checks` 経路（helper を実行できない環境）はこれに加えて親の差し替えの窓が残り、root の外に書き・読める
  （0005 の既知の穴。今回の変更で新しく生じたものではない）。
- 脅威モデル: 同一ユーザーの別プロセスは root に直接書けるため、CAS は行儀の良い並行 writer のためのもので、
  攻撃者の境界ではない（docs/workspace.md の脅威モデルと同じ線引き）。
- 反映: docs/workspace.md の TOCTOU 節に、許容の理由・影響・閉じ方（`renameat2` の native helper、配布 0040）・
  `checks` には落とさない方針・保証表と T-03 の非原子性を追記。docs/safety.md は「塞いだ」を dirfd 限定にし、
  「残っている」に `checks` の親の窓を独立行で追加。
- issue が想定していた「カーネル非対応時は `checks` へフォールバック」は採らない。親の窓を開け直して
  dirfd より弱くなるため（review の blocking 指摘）。
- 実装しないため回帰テストは足していない。根拠は既存 `packages/workspace/test/toctou.test.ts`（15/15。
  dirfd は root の外に 0 件、`checks` は write / read が root の外に出る対照を含む）。
- 将来 native helper を入れるときの確認事項: probe で renameat2 の対応を確かめ、一般の probe 失敗
  （`checks` へフォールバック）と capability 失敗（開かない）を混ぜない。
- 独立 review: **toctou-review / FAIL / HEAD f7e98a6**（blocking 2）→ 修正 d9fa963 で **PASS** → low 3件を
  2b1ba96 で修正し **PASS**。最終 HEAD 2b1ba96、blocking なし。
- 残件（low）: `docs/safety.md:29` の既存 0033 参照は今回の範囲外。`docs/workspace.md:18` の「窓が残る」は
  親の解決と最終コンポーネントの CAS を分けて書くと保証表と揃う。
- issue 候補（既存）: `checks` 経路の封じ込め（親の差し替えで root 外 write / 秘密 read。test が再現を固定）。
  helper が temp を再ハッシュしない（temp を symlink に差し替えると版の報告がずれる）。

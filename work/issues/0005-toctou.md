# 0005: TOCTOU の窓を閉じる

status: done
depends-on: -
touches: work/poc/workspace-core, docs/workspace.md

## Goal

検査（canonical 化）と使用（open / rename）を同一の解決にする。今は rename 直前に親を再確認するだけで、
確認と rename の間に親を差し替えられれば root の外に出られる。

## Acceptance criteria

- [x] 親ディレクトリを差し替えながら書き込みを繰り返しても、root 外に書かれない
- [x] 読取も `noFollow` + fd 相対で開き、最終コンポーネントの差し替えを許さない
- [x] 非対応環境では現行の mitigation（親の再確認 + `unknown`）にフォールバック

## Notes

選択肢: (a) pi-env daemon に `openat2` 相当の操作を足す、(b) 小さな helper を `exec` で呼ぶ、
(c) 独自 Worker で解決する。`ExecutionEnv` の拡張が要るため、まず (a) の可否を調べる。
Linux 以外（macOS / Windows）は別の API になる。

## Log

- 2026-11-06: 作成。現状は親の再確認で窓を狭め、変更を `unknown` として扱う。
- 2026-11-07: (a) を却下。(b) で実装。pi-env 1.5.0 の protocol に fd 相対の操作は無く（`docs/protocol.md` の op 表）、
  足すには pin した外部パッケージの fork になる。helper は `/proc/self/fd/<dirfd>/<name>` で openat 相当を行い、
  比較と rename を 1 プロセスにまとめる。判断は D034。

## Result

- `work/poc/workspace-core/rooted.mjs`: root の dirfd を開いて `.hns/root.json` と dev / ino を照合し、
  親を `O_NOFOLLOW | O_DIRECTORY` で辿る。`hash` / `read` / `commit`（再ハッシュ + rename）を提供。
- `Workspace` は起動時に 1 回 `probe` し、通れば読取と書込の解決を helper に任せる（`mode: "dirfd"`）。
  通らなければ従来の経路（`mode: "checks"`）にそのまま落ちる。
- `work/poc/workspace-core/toctou.mjs` **32/32**: 差し替え中の書込・読取が外に出ないこと、`checks` では
  実際に出てしまうこと（窓の証拠）、最終コンポーネントの symlink 拒否、exec が無いときのフォールバック。
- 既存の `run.mjs` 40/40、`root-swap` 12/12、`root-containment` 21/21 も通る。
- 途中で、親が無い場所への書き込みが `applied` と報告される（`renameFile` の失敗を捨てていた）のに気づいた。
  両経路が `not_found` を投げるように揃えた。ディレクトリ・FIFO・絶対パス・`..`・`.git` の扱いは両経路で同一を確認。

## 残り

- helper をリモートの daemon に配る手段（いまは「動かない環境では checks に落ちる」だけ）。
- 1 操作 1 プロセスの起動コスト。常駐化するなら exec ではなく別の受け渡しが要る。
- dirfd 経路の読取上限（8 MiB）、巨大ファイル、ディレクトリ fsync、Journal の原子化は未対応のまま。

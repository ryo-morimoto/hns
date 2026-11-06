# 0005: TOCTOU の窓を閉じる

status: open
depends-on: -
touches: work/poc/workspace-core, docs/workspace.md

## Goal

検査（canonical 化）と使用（open / rename）を同一の解決にする。今は rename 直前に親を再確認するだけで、
確認と rename の間に親を差し替えられれば root の外に出られる。

## Acceptance criteria

- [ ] 親ディレクトリを差し替えながら書き込みを繰り返しても、root 外に書かれない
- [ ] 読取も `noFollow` + fd 相対で開き、最終コンポーネントの差し替えを許さない
- [ ] 非対応環境では現行の mitigation（親の再確認 + `unknown`）にフォールバック

## Notes

選択肢: (a) pi-env daemon に `openat2` 相当の操作を足す、(b) 小さな helper を `exec` で呼ぶ、
(c) 独自 Worker で解決する。`ExecutionEnv` の拡張が要るため、まず (a) の可否を調べる。
Linux 以外（macOS / Windows）は別の API になる。

## Log

- 2026-11-06: 作成。現状は親の再確認で窓を狭め、変更を `unknown` として扱う。

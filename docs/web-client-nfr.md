# Web client の非機能要件（全画面の baseline）

2026-11-17 / lead。0106 の editor 固有の NFR に加え、web client 全体の非機能予算を固定する。

## 現状（実測）

- `packages/web/dist` の初期 JS は 1 chunk: **702KB raw / 208.9KB gzip**（2026-11-17、editor 未実装）。CSS は 3.4KB gzip。
- 初期 chunk には React / Relay / TanStack Query / Base UI が入る。editor を足す前に、この数字を基準にする。

## 性能

| ID | 要件 | 目標 | 測り方 |
| --- | --- | --- | --- |
| W-P1 | 初期 JS | **≤250KB gzip**（現在 209KB） | build の出力。超えたら分割か依存を削る |
| W-P2 | CSS | **≤20KB gzip** | build |
| W-P3 | 画面ごとの lazy chunk | **≤150KB gzip**（editor は 0106 の ≤350KB を例外） | build / route 分割 |
| W-P4 | LCP（p75） | **≤2.5s**（edge / local） | 0114 / 0043 の実測 |
| W-P5 | INP（p75） | **≤200ms** | 0114 / 0043 |
| W-P6 | CLS | **≤0.1** | 0114 / 0043 |
| W-P7 | 画面遷移 | **≤200ms**（クリック → 次の画面の骨格） | 0114 |
| W-P8 | 一覧の初回 | **≤300ms**（≤500 行） | 0114 / 0163 |
| W-P9 | 送信の echo | **≤100ms**（ローカル表示） | 0105 / 0114 |
| W-P10 | メモリ | 画面を離れたら listener / observer / timer を解放 | 0114 |

## 信頼性・データ安全

- 失敗・不明を成功として表示しない（保存・送信・設定）。
- 画面 / プロジェクト / 会話の切り替えで古い要求を abort し、別の対象に書かない。
- dirty / 未保存があるときは遷移前に確認する。
- オフライン / 切断は型付きの失敗として出し、古い内容を新しいと偽らない。

## アクセシビリティ / モバイル / 対応環境

- **WCAG 2.2 AA**: キーボードだけで主要フロー、focus 管理、ラベル、コントラスト、reduced motion。
- **モバイル**: タッチ対象 ≥44px、hover 前提なし、iOS Safari の safe area / 仮想キーボード、Firefox のモバイル表示。
- **ブラウザ**: Chrome / Safari / Firefox の現行（desktop）、Firefox のモバイル表示、iOS Safari。IE は対象外。E2E は Chromium / Firefox / mobile Firefox までで、Safari / iOS Safari / 実機 Android は E2E の対象外。手動確認は 0113 / 0114 のどちらに置くか未確定（現時点では未検証）。

## セキュリティ / 観測

- CSP。`eval` / リモートコード / 第三者スクリプトを足さない。
- 本文・パス・トークンをログ / metric / エラー報告に出さない。
- クライアントの計測（画面 / 操作 / 失敗 / latency）は 0162 / 0163 に送る。内容は送らない。
- 秘密は `~/.config/hns/` の外に出さない。ブラウザに provider 鍵を置かない。

## 検証

- 性能は CI の合否にしない（flaky）。issue に before / after を残し、0114 の実測と 0043 の E2E で固定する。E2E のブラウザ行列は [testing.md](testing.md)（D101）を単一の出所にする。
- a11y は 0113 のキーボード / SR 確認と component test。
- 予算を超えたら、その issue で理由と代替を記録する（黙って超えない）。

## 関連

- editor 固有: 0106 の NFR（lazy 350KB、open 500ms、保存 1s、a11y、モバイル）。
- スタック: D043（React 19 / Vite / TanStack / Base UI）。型: D044。
- テストのブラウザ行列: [testing.md](testing.md)（D101）。
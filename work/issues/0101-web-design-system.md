# 0101: Web のデザインシステムとプリミティブ

status: open
depends-on: 0100
touches: packages/web/src/design, packages/web/src/components/Button.tsx, packages/web/src/components/Badge.tsx, packages/web/src/components/Icon.tsx, packages/web/src/components/Dialog.tsx, packages/web/src/components/Menu.tsx, packages/web/src/components/Toast.tsx, packages/web/src/components/Skeleton.tsx, packages/web/test/design, packages/web/package.json, package-lock.json

## Goal

PoC のトークンと操作感を、製品のデザインシステムに落とす。
見た目の部品ではなく、focus / hover / selected / disabled / reduced motion を含む状態の契約にする。

## Acceptance criteria

- [ ] light / dark の CSS 変数（背景・面・境界・本文・補助・accent・danger・warn・ok・focus）
- [ ] Button（primary / ghost / danger / icon / disabled）、Badge、Icon、Skeleton
- [ ] Dialog と Menu は Base UI（`@base-ui/react` 1.9.0）を土台にし、Esc / focus 戻し / outline を満たす。独自 focus trap を書かない
- [ ] Toast は role=status / alert と action（Undo）を持つ
- [ ] prefers-reduced-motion で motion を止める。focus-visible を全 interactive 要素に
- [ ] 各プリミティブの render / keyboard テスト。disabled と loading の見た目が状態で分かる
- [ ] 「2箇所以上で使う部品だけ」を作る。使われない variant を足さない

## Notes

- プリミティブの土台は Base UI（`@base-ui/react` 1.9.0、exact pin、D043）。0100 では未使用のため追加していない。Tailwind は入れない（CSS 変数のトークン）
- PoC の app.css をそのまま持ち込まない。トークンと必要な部品だけを抽出する
- 色は light / dark の両方でコントラストを確認する。accent を本文色に使わない
- Icon は SVG path を1箇所にまとめ、サイズは 12 / 14 / 16 に限定する
- Dialog はネイティブ dialog を使い、独自 focus trap を書かない

## やらないこと

- 画面固有のレイアウト（0102 以降）
- CommandPalette（0103）
- Editor（0106）

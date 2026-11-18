# office pack

Office エンジン（ibisOffice）を、**同じ手順で・同じ結果になるように**同梱する（0235 / D102）。
このディレクトリは pack を作る・検証する・叩くためのスクリプトとテストだけを持つ。pack 本体は
`office-pack/`（リポジトリ直下、`.gitignore` 済み）に出力する。

- 版は **ibisOffice v0.8.7**、AppImage の sha256 `0c6b15d9...085dd`（51,472,144 bytes）で固定する。
- フォントは pack に同梱し、**ホストのフォントを読まない**（見た目を機械によらない）。
- 実行時に pack の外から見せるものは `manifest.json` の `build.runtime.bindPaths` に**パスと
  sha256 で明記**し、実行時に探索しない。

## 作る / 検証する

```bash
tools/office-pack/build.sh                    # office-pack/ を作る（約 550 MB）
tools/office-pack/verify.sh                   # manifest の sha256 と法務 4 点を照合
tools/office-pack/build.sh                    # 2 回目: manifest.json の sha256 が同じになる
node tools/office-pack/pack.mjs render --pack office-pack   # render できるか（理由にパス）
node tools/office-pack/pack.mjs fonts  --pack office-pack   # fonts.conf が実際に解決するフォント
```

`build.sh` は初回に次を取得する（2 回目以降は `.cache/office-pack/inputs/` のキャッシュ）。

| 入力                | 版          | sha256                                                             |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| ibisOffice AppImage | v0.8.7      | `0c6b15d93b285cd87fece776ea6be0d79d826c8888f2864dc7f02033330085dd` |
| IPAexGothic         | ipaexg00401 | `4ab6fee94bf6f94b3eeb31be2b73c559f738dc6b336d722d5301b1f3f592f850` |
| Noto Sans JP        | Sans2.004   | `2bbdd2c20f30670b39ca735c96d75f1fdabdb348103e43b820cf17701fd22b18` |
| DejaVu Sans         | 2.37        | `fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7` |

sha256 が違えば **展開する前に止まる**。版を上げるのは `build.sh` の上の方の定数を書き換えること（引数では変えない）。

### pack の中身

```
office-pack/
  bin/ibisOffice                          release のバイナリ（無改変）
  lib/                                    エンジン + X11 + lavapipe + Vulkan loader（平坦）
  lib/store/<store-path>/...              /nix/store の絶対パスで見せるための同じバイト列
  store/<store-name>/...                  上のミラーへの相対 symlink（sandbox の bind 元。manifest の build.symlinks）
  fonts/                                  IPAexGothic / Noto Sans JP (Regular, Bold) / DejaVu Sans
  fonts.conf                              FONTCONFIG_PATH からの相対ディレクトリだけを指す
  share/vulkan/icd.d/lvp_icd.x86_64.json   Mesa が書いた ICD（driver は絶対 store パス）
  LICENSE / NOTICE / SOURCE.md / About.txt AGPL の 4 点
  legal/                                  フォントのライセンス
  manifest.json                           docs/office.md 11 章（files は sha256 文字列だけ）+ build（symlink・環境・bindPaths・入力）
```

`DejaVu Sans` は見た目の選択ではない。エンジンは UI の既定フォント（`.SystemUIFont`）を DejaVu 等で解決し、
**1 つも無いと起動しない**（panic、exit 101）。逆に CJK フォントが無いと**黙って別のフォントで描く**ので、
`pack.mjs fonts` が fonts.conf の実解決（fc-list）で欠落を報告する（下の「失敗時の見え方」）。

## 入れる

1. **開発機**: `tools/office-pack/build.sh` を一度走らせれば `office-pack/` にできあがる（キャッシュは `.cache/office-pack/`）。
2. **配布物**: `deploy/assets` などに `office-pack/` を丸ごと置く。git には入れない（`.gitignore`）。
   中に何が入っているかは `manifest.json` の `files` が全て列挙する（`verify.sh` と一致しなければ使えない）。
3. **別のホストで作る**: `/nix/store` に X11 / Mesa / Vulkan が無いホストではこのビルドは止まる（足りないものの名前を出す）。

`office-pack/` は **machine の ROOT の外**に置き、office の実行時だけ sandbox に **ro bind** する（0236 / 0194）。
machine は起動時に `tools/office-pack/verify.sh <pack>` 相当（`manifest.json` の `files` の sha256）を照合し、
合わなければ `officeEngine` を `{ available: false, reason }` にする。

## sandbox から見えるパス（ro bind）

pack のバイナリは Nix のバイナリで、`/nix/store/<hash>-<name>/lib/libX.so.N` を**絶対パスで**記録している。
loader はそれを `LD_LIBRARY_PATH` より先に見るので、sandbox では次の 2 つを ro bind する。

| bind するもの                    | sandbox 内のパス          | 理由                                                                    |
| -------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `office-pack/`                   | 任意（machine が決める）  | `bin/ibisOffice`, `lib/`, `fonts/`, `fonts.conf`, `share/vulkan/icd.d/` |
| `office-pack/store/<store-name>` | `/nix/store/<store-name>` | pack の中のライブラリが互いを絶対 store パスで探すため                  |

`LD_LIBRARY_PATH=<pack>/lib`、`FONTCONFIG_FILE=<pack>/fonts.conf`、`FONTCONFIG_PATH=<pack>`、
`VK_ICD_FILENAMES` / `VK_DRIVER_FILES=<pack>/share/vulkan/icd.d/lvp_icd.x86_64.json`。
値は `manifest.json` の `build.environment` にそのまま書いてある。

`build.runtime.bindPaths` は、**pack が持たない部分を絶対パス + sha256 で宣言**した配列（0236 が ro bind に写す）。
今は 1 つ、ICD が指す Mesa の lavapipe（`/nix/store/<...>-mesa-<v>/lib/libvulkan_lvp.so`）。
同じバイト列は `lib/store/` にも入っていて、それだけで preview / render は動く。宣言しているのは
「実行時にこのパスが見えていること」を `officeEngine` が**このホストを見ずに**答えられるようにするため。

## 失敗時の見え方

| 状態                                                          | 起きること                                                                                           | 分かる場所                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| バイナリが 1 バイト違う                                       | 起動しない（`symbol lookup error`）。`verify.sh` が落ち、manifest の sha256 と実ファイルを並べて出す | `verify.sh`（C2）                   |
| pack に manifest が知らないファイルがある                     | `verify.sh` が「manifest に無い」と言う                                                              | `verify.sh`                         |
| `store/` の symlink を張り替えた（manifest ごと書き換えても） | `verify.sh` が「points at …」／「points outside the pack」と言う（中身だけ変えた場合も落ちる）       | `verify.sh`（`build.symlinks`）     |
| `bindPaths` の sha256 が不正／実ファイルと不一致              | `render` が「has no sha256」／「is not the file the manifest names」で能力なしにする                 | `pack.mjs render`（B1）             |
| 取得に失敗した／取得したが digest が違う                      | 別々のメッセージで停止（`could not download <url>`／`sha256 is X, expected Y; refusing to unpack`）  | `build.sh`（NB4）                   |
| LICENSE / NOTICE / SOURCE.md / About.txt が無い               | `verify.sh` が落ちる（配布物として不完全）                                                           | `verify.sh`（C5）                   |
| CJK フォントが無い                                            | **PDF は出る**（Noto か代替で描く）。エンジンは何も言わない                                          | `pack.mjs fonts` の `missing`（C3） |
| フォントが 1 つも無い                                         | エンジンが `.SystemUIFont` を解決できず panic（exit 101）                                            | プロセスの exit code                |
| lavapipe が無い                                               | **PDF は出る・PNG は `no HeadlessRenderer configured` で exit 1**                                    | `pack.mjs render` の `reason`（C4） |
| Vulkan loader が古い（1.4.341）                               | PDF は出る・PNG だけ落ちる（1.4.363 で直る。測った結果を build.sh に固定）                           | 同上                                |

`officeEngine` は上の表の右端を返す（黙って `unsupported` に丸めない）。

## テスト

```bash
npx vitest run --project tools tools/office-pack    # 単体 + 統合（前提が無ければ理由を出して skip）
HNS_REQUIRE_OFFICE_PACK=1 npx vitest run --project tools tools/office-pack   # skip を失敗にする（CI）
```

- `pack.test.ts`: manifest の形（11 章と core の schema）、pin された sha256、verify の検査項目、
  手作りの pack に対する C1/C2/C5 と render の判定。
- `test/integration/office-pack.integration.test.ts`: 実際に pack を作り、C1 から C5 と T3（2 回同じ manifest）を
  **pack のバイナリを直接叩いて**確かめる（machine は使わない）。回すには GitHub から 51 MB 取れること、
  /nix/store に mesa / vulkan-loader / libxcb があること、fontconfig の `fc-list` があることが要る。
  どれか欠けると **理由を出して skip** し、`HNS_REQUIRE_OFFICE_PACK=1` なら失敗にする。
- 統合テストは build に約 4 秒（キャッシュ済み）、T3 でもう 1 回作る。CI では `.cache/office-pack/inputs/` を
  キャッシュすると毎回の 51 MB の取得を避けられる。

テスト用の文書は `test/fixtures/ja.docx`（日本語 4 段落、3 KB、`test/make-fixture.mjs` で生成）。

`tsconfig.json` はこのディレクトリの TypeScript を `npm run check` の typecheck に載せるため
（`tools/gate/stages.ts` が `tools/office-pack/tsconfig.json` を読む）。`pack.mjs` は依存ゼロの JavaScript で、
ゲートの oxfmt / oxlint の対象外（代わりにテストが実際に動かして検証する）。

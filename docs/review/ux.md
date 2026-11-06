# UI/UX の観点

画面・操作・状態・文言に触る変更で読む。設計時の規律は [../design/interface.md](../design/interface.md)、
手順と判定は [../review.md](../review.md)。根拠は実例（リンク）で示す。

| 観点 | 条件 | 確認 | Ref |
| --- | --- | --- | --- |
| 仕事が主役 | 画面の中心が会話ログになっている | 一覧の先頭が「今の仕事」か。会話が仕事に紐づいているか | [Linear AIG](https://linear.app/developers/aig) |
| 注意の順序 | ホーム・一覧・ダッシュボード | Needs you → Running → Completed の順か。バッジの件数と一覧の実数が一致するか。空表示があるか | [Linear AIG](https://linear.app/developers/aig) |
| 透明性の既定 | 実行ログ・進捗・ツール表示 | 既定は要約で、詳細は開いた人だけか。エラーと判断待ちは既定で出るか | [Manus](https://manus.im) |
| レビュー面 | 完了・承認の画面 | diff・テスト結果・変更ファイル・未解決が1箇所にあるか。Review / Revise の2択があるか | [Cursor](https://cursor.com) |
| 直接編集 | 生成物を見せる | プロンプトを書き直さず編集・却下・部分採用できるか。編集が正本（ファイル）の版チェックを通るか | [Replit Agent](https://replit.com) |
| 非同期 | 時間のかかる実行 | 完了を待たずに別の仕事へ移れるか。戻ったとき状態と結果が分かるか。中断・再開があるか | [Claude Cowork](https://claude.com/product/cowork) |
| 中断可能性 | アニメーション・遷移・ドラッグ | 途中で逆方向へ操作して破綻しないか。操作がアニメーション終了を待たないか | [Rauno — Craft](https://rauno.me/craft) |
| 空間の連続性 | 要素の移動・変形・展開 | 同じものだと分かるか（位置・形・色の連続）。消して別物を出す遷移になっていないか | [tldraw flash](https://flash.tldraw.com) |
| 入力の精度 | スライダー・ドラッグ・数値入力 | 大きく動かすときと微調整で感度が変わるか。キーボードでも同じ値にできるか | [Rauno — Craft](https://rauno.me/craft) |
| 知覚遅延 | AI 生成・待ちが入る操作 | 最初の入力に即座に反応するか。結果の更新を待たせていないか | [Krea](https://www.krea.ai) |
| 頻度 | 毎日使う操作 | 頻繁な操作に長い演出が入っていないか。演出が初回・完了・異常に寄っているか | [FigJam](https://www.figma.com/figjam/) |
| 情報密度 | 一覧・詳細・設定 | 重要な情報が強く、補助が後退しているか。すべて同じ強さになっていないか | [Are.na](https://www.are.na) |
| キーボード同等 | 主要操作 | マウスでできることをキーボードでもできるか。フォーカスが見え、順序が自然か | [FigJam](https://www.figma.com/figjam/) |
| 状態の網羅 | 画面・部品 | loading / empty / error / 権限なし / 保存中 / 競合 / undo があるか | [Linear](https://linear.app) |
| 意図の確認 | Agent に依頼する画面 | 曖昧な依頼で1〜3個だけ聞くか。触ってよい範囲（パス・環境）が見えるか | [Setproduct](https://www.setproduct.com/blog/ai-agent-ui-design-patterns) |
| 計画の可視化 | 実行前 | 計画を編集できるか。工数・費用の目安が出るか。ドライランがあるか | [Setproduct](https://www.setproduct.com/blog/ai-agent-ui-design-patterns) |
| 実行台帳 | 実行中 | 何をしたかが1行ずつ積まれるか。ツール呼び出しに引数と結果があるか。失敗は既定で開くか | [AI Design Guide](https://www.aidesign.guide/agentic-ux-patterns) |
| 承認の粒度 | 権限・承認の画面 | 危険度で止め方が変わるか。同種の承認を束ねられるか。「今後は聞かない」があるか | [AI Design Guide](https://www.aidesign.guide/agentic-ux-patterns) |
| 中断と引き継ぎ | 実行中・計画段階 | 停止して人間が操作できるか（Take Control）。指示を変えられるか。別の人へ渡せるか | [Setproduct](https://www.setproduct.com/blog/ai-agent-ui-design-patterns) |
| 結果の提示 | 完了 | 変更の footprint が先か。確信度と未解決が分かれているか | [Setproduct](https://www.setproduct.com/blog/ai-agent-ui-design-patterns) |
| 監査と取消 | 完了後 | 各操作が見つかるか。Undo・チェックポイント・ハンク単位の Keep/Undo/Apply があるか | [AI Design Guide](https://www.aidesign.guide/agentic-ux-patterns) |
| 自律度 | 実行の設定 | 計画だけ / 編集まで / 自動 を選べるか。既定は安全側か | [AI Design Guide](https://www.aidesign.guide/agentic-ux-patterns) |
| 再入場 | タブを戻る・通知から戻る | 何が起きたか1画面で分かるか。受信箱（Needs input / Working / Completed）と件数が合うか | [AI Design Guide](https://www.aidesign.guide/agentic-ux-patterns) |
| 入力の入口 | 入力・コマンド・パネル | ⌘K で移動と AI 依頼の両方ができるか。sparkle・ドックパネルなど入口が散らばっていないか。何を文脈に入れているか表示されるか | [AI Design Guide](https://www.aidesign.guide/agentic-ux-patterns) |

## 証拠

- **exact HEAD** の画面で確認する。route・状態・viewport（1280 / 320 / 200% 拡大）・入力手段を記録する。
- 全体（shell・main・overlay・scroll）、変更 section と隣接、要素内部の3段階。全体1枚だけ、切り抜きだけは PASS の証拠にしない。
- focus・keyboard・status message は**実操作**で確かめる。DOM の存在だけを証拠にしない。
- 数値は browser の geometry / computed style から取る。目視の推測で埋めない。
- 測れなかったものは「未確認」と書く。pixel 差分の量を品質の点数にしない。

## 判定

blocking（この変更で生まれたもの）: 判断を誤らせる表示、操作できない、情報が消える・戻せない、必須の状態が無い、
キーボードで主要操作ができない。**好み・余白の趣味・アニメの長さの好みは blocking にしない**（残件として書く）。

## Interaction Research Note

参考事例を研究するときは1事例1枚で残す。

```markdown
- 対象（プロダクト / 画面 / 操作）:
- この Interaction の目的:
- 観察（分解して書く。位置・幅・角丸・透明度・時間・入力）:
- 実装の仮説（hns のどの画面に、どう効くか）:
- 確かめ方（操作・viewport・キーボード）:
- 結果と採否:
```
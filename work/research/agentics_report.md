# エージェンティクス（Agentic AI）レポート
## 自律的に推論・行動・相互作用するLLMベースシステムの体系

**作成日**: 2026-11-06  
**対象**: Agentic AI / エージェンティックAI / エージェンティクス  
**注記**: 「エージェンティクス」は確立された学術用語ではないが、本レポートでは **Agentic AI（エージェンティックAI）** を中心に、エージェント的な振る舞いをするLLMシステム全般を扱う。

---

## 概要

Agentic AI（エージェンティックAI）とは、単にテキストを生成するだけでなく、**目標に向かって推論し、ツールを使って行動し、環境や他のエージェントと相互作用しながらタスクを完遂する** LLMベースのシステムを指す。

従来のLLMが「受動的なテキスト生成器」であったのに対し、Agentic AIは「自律的な行為主体」へとシフトしたパラダイムである。

主要な定義軸としてよく用いられるのは以下の3つである：

1. **Reason（推論）**: 計画・振り返り・検索
2. **Act（行動）**: ツール使用・ロボット制御・環境への働きかけ
3. **Interact（相互作用）**: マルチエージェント協調・社会シミュレーション

---

## コア概念

### 1. Agentic LLM（エージェンティックLLM）の定義

#### 概要
推論・行動・相互作用の3能力を備えた大規模言語モデルベースのエージェント。

#### 詳細
- 単一ターンの応答ではなく、長期的な目標達成のために状態を保持し、計画を立て、行動を修正する。
- 文献では「Agentic LLMs are LLMs that (1) reason, (2) act, and (3) interact」と定義されることが多い。

#### 主要論文
- Plaat et al. (2025). *Agentic Large Language Models, a survey*. arXiv:2503.23037

---

### 2. Reasoning（推論能力）

#### 概要
計画立案、自己振り返り、情報検索を通じて意思決定の質を高める能力。

#### 詳細
- Chain-of-Thought、Reflection、Tree-of-Thought、ReActなどの手法が含まれる。
- 外部知識の取得（RAG）と組み合わせることで、ハルシネーションを抑えつつ複雑な推論を可能にする。

#### 主要論文
- Plaat et al. (2025). *Agentic Large Language Models, a survey*. arXiv:2503.23037
- Wei et al. (2026). *Agentic Reasoning for Large Language Models*.

---

### 3. Acting / Tool Use（行動・ツール使用）

#### 概要
外部ツールやAPI、物理環境に働きかけて実際のタスクを完遂する能力。

#### 詳細
- 関数呼び出し（Function Calling）、コード実行、ブラウザ操作、ロボット制御などが含まれる。
- ツールがなければモデルは「話すだけ」であり、ツールがあって初めて「行動」できる。

#### 主要論文
- Plaat et al. (2025). *Agentic Large Language Models, a survey*. arXiv:2503.23037
- *From language to action: a review of large language models as autonomous agents and tool users*.

---

### 4. Interacting / Multi-Agent Systems（相互作用・マルチエージェント）

#### 概要
複数のエージェントが役割を分担し、協調・競合・対話を通じて複雑な問題を解く仕組み。

#### 詳細
- Supervisor-Worker、Hierarchical、Swarmなどのパターンが存在する。
- 社会シミュレーションや創発的振る舞いの研究にも用いられる。

#### 主要論文
- Plaat et al. (2025). *Agentic Large Language Models, a survey*. arXiv:2503.23037
- *From Language Models to Agentic AI: A Survey of Autonomous, Action-Enabled, and Collaborative LLM Agents*.

---

### 5. エージェントの基本アーキテクチャ

#### 概要
Perception（知覚）→ Reasoning（推論）→ Action（行動）→ Feedback（フィードバック）のループ構造。

#### 詳細
- 古典的なエージェントループをLLMで実装したもの。
- メモリ、計画、ツール使用がこのループ内で統合される。

#### 主要論文
- Wang et al. *A Survey on Large Language Model based Autonomous Agents*. arXiv:2308.11432
- *The rise and potential of large language model based agents: a survey*.

---

## 周辺・補完的な概念

### 1. Harness Engineering（ハーネスエンジニアリング）

#### 概要
モデルを取り巻く実行環境（ツール、権限、状態管理、検証）を設計する技術。

#### 詳細
「エージェント = モデル + ハーネス」という定式化が一般的。同じモデルでもハーネスの設計で性能が大きく変わる。

#### 主要論文
- Barbaste et al. (2026). *Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents*. arXiv:2609.00006

---

### 2. Loop Engineering（ループエンジニアリング）

#### 概要
エージェントが目標に到達するまで自動的に反復する制御構造を設計する手法。

#### 詳細
トリガー、ゴール、検証、停止条件、メモリを明示的に設計する。

#### 主要論文
- Lulla et al. (2026). *Loop Engineering: Building Blocks, Adoption, and Impact*. arXiv:2608.21884

---

### 3. Graph Engineering（グラフエンジニアリング）

#### 概要
複数のエージェントやステップをノードとエッジで明示的に接続する手法。

#### 詳細
個別エージェントの知能から、システム全体の知能への移行を担う。

#### 主要論文
- Feng et al. (2026). *Graph Engineering in the Era of LLM Agents*. arXiv:2608.21156

---

### 4. Context Engineering（コンテキストエンジニアリング）

#### 概要
推論時にモデルが参照する情報全体を系統的に設計・管理する手法。

#### 詳細
プロンプト、取得情報、メモリ、ツール結果などを最適に配置する。

#### 主要論文
- *A Survey of Context Engineering for Large Language Models*. arXiv:2507.13334

---

### 5. Agentic Environment Engineering（エージェント環境エンジニアリング）

#### 概要
エージェントが相互作用する環境そのものを設計・合成・進化させる手法。

#### 詳細
静的データセットから、エージェントと共に進化する動的環境への移行。

#### 主要論文
- Li et al. (2026). *Agentic Environment Engineering for Large Language Models*. arXiv:2606.12191

---

### 6. Evaluation & Safety（評価と安全性）

#### 概要
エージェントの信頼性、堅牢性、安全性を評価・担保する技術。

#### 詳細
静的ベンチマークから、インタラクティブ環境での評価、ガードレール、人間介在へと移行している。

---

## 全体像

```
LLM（テキスト生成）
    ↓
Agentic LLM（推論・行動・相互作用）
    ↓
エンジニアリングレイヤーで性能を最大化
    - Context Engineering
    - Harness Engineering
    - Loop Engineering
    - Graph Engineering
    - Agentic Environment Engineering
```

Agentic AIは「何をするか」を定義し、各種エンジニアリング手法は「どうやって安定的に実現するか」を設計する関係にある。

---

## まとめ

エージェンティクス（Agentic AI）は、LLMを受動的な生成器から自律的な行為主体へと転換するパラダイムである。  
その実現には、推論・行動・相互作用の3能力に加え、ハーネス・ループ・グラフ・環境といった周辺のエンジニアリングが不可欠である。

本レポートで挙げた論文は、この分野の体系化を試みる主要なサーベイであり、今後の研究・実装の出発点となる。

---

**主要参考文献**
- arXiv:2503.23037 — Agentic Large Language Models, a survey
- arXiv:2308.11432 — A Survey on Large Language Model based Autonomous Agents
- arXiv:2507.13334 — A Survey of Context Engineering for Large Language Models
- arXiv:2609.00006 — Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents
- arXiv:2608.21884 — Loop Engineering: Building Blocks, Adoption, and Impact
- arXiv:2608.21156 — Graph Engineering in the Era of LLM Agents
- arXiv:2606.12191 — Agentic Environment Engineering for Large Language Models

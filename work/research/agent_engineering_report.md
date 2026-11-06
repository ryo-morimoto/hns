# エージェントエンジニアリング レポート
## 重みを変えずにエージェント性能を向上させるフレームワーク群

**作成日**: 2026-11-06  
**対象**: LLMベースのエージェントシステムにおける性能向上手法  
**スコープ**: モデルの重みを更新せず、推論時・実行環境・ワークフロー設計で性能を上げる技術

---

## 概要

本レポートは、LLMの重みを固定したまま、特定タスクや汎用的なエージェント性能を向上させるためのエンジニアリング手法を体系的に整理したものである。

近年のエージェント開発では、単一のプロンプト最適化から始まり、コンテキスト管理、実行環境（ハーネス）、反復ループ、複数エージェントのグラフ構造、さらには環境そのものの設計へと、制御の対象が上位レイヤーに移行している。

これらの手法は排他的ではなく、層状に積み重なる。適切なレイヤーを選択・組み合わせることで、同じ基盤モデルでも大幅な性能向上が実現可能である。

---

## コア概念

### 1. Prompt Engineering（プロンプトエンジニアリング）

#### 概要
モデルに与える指示文（プロンプト）を設計・最適化することで、単一推論の出力品質を向上させる手法。

#### 詳細
- 役割・指示・制約・出力形式・例示などを構造化する。
- Chain-of-Thought（CoT）、Few-shot、Self-Consistencyなどのテクニックが含まれる。
- 単一ターンの性能に直接影響するが、長時間・多ステップタスクでは限界がある。

#### 主要論文
- Schulhoff et al. (2024). *The Prompt Report: A Systematic Survey of Prompt Engineering Techniques*. arXiv:2406.06608
- Liu et al. (2025). *A Comprehensive Taxonomy of Prompt Engineering Techniques for Large Language Models*.

---

### 2. Context Engineering（コンテキストエンジニアリング）

#### 概要
モデルが推論時に参照する情報全体（プロンプト＋取得情報＋メモリ＋ツール結果など）を系統的に設計・管理する手法。

#### 詳細
- プロンプトエンジニアリングを包含しつつ、情報の選択・圧縮・配置・更新までを扱う。
- RAG、メモリシステム、ツール統合、マルチエージェント間の情報共有が含まれる。
- エージェントが長期的に動作する場合、コンテキストの劣化（collapse）やノイズ増加を防ぐことが重要。

#### 主要論文
- *A Survey of Context Engineering for Large Language Models*. arXiv:2507.13334
- Zhang et al. (2025). *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models* (ACE). arXiv:2510.04618
- Anthropic. *Effective Context Engineering for AI Agents* (2025)

---

### 3. Harness Engineering（ハーネスエンジニアリング）

#### 概要
モデルを取り巻く実行環境全体（ツール、権限、サンドボックス、状態管理、検証、観測性など）を設計する手法。  
「エージェント = モデル + ハーネス」という定式化が一般的。

#### 詳細
- ツール呼び出しインターフェース、実行サンドボックス、パーミッション制御、状態の永続化、検証ループなどを含む。
- 同じモデルでもハーネスの設計次第で性能が大きく変わる（数倍の差が出るケースも報告）。
- コーディングエージェントを中心に急速に成熟した領域。

#### 主要論文
- Barbaste et al. (2026). *Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents*. arXiv:2609.00006
- *Agent Systems with Harness Engineering: A Systematic Survey*.
- Seong et al. (2026). *The Last Harness You'll Ever Build*. arXiv:2604.21003
- Hong et al. (2026). *HarnessFlow: MCTS-Guided Harness Optimization for LLM Agents*. arXiv:2611.06254

---

### 4. Loop Engineering（ループエンジニアリング）

#### 概要
エージェントが目標に到達するまで自動的に反復する制御構造（トリガー、目標、検証、停止条件、メモリ）を設計する手法。

#### 詳細
- 「人間が毎回プロンプトを打つ」状態から、「システムがエージェントをプロンプトする」状態への移行。
- 典型的な要素：トリガー（スケジュール/イベント）、明確なゴール、検証ステップ、停止条件、永続状態。
- 無限ループや自己検証の甘さを防ぐ設計が重要。

#### 主要論文
- Lulla et al. (2026). *Loop Engineering: Building Blocks, Adoption, and Impact*. arXiv:2608.21884
- Macedo (2026). *Stop Hand-Holding Your Coding Agent: Engineering the Loops that Replace Step-by-Step Prompting*. arXiv:2607.00038
- *The Agent Loop: A Survey of Control Strategies, Skills, and Harnesses for LLM Agents*.

---

### 5. Graph Engineering（グラフエンジニアリング）

#### 概要
複数のエージェントやステップをノードとエッジで明示的に接続し、制御フローを構造化する手法。  
個別知能からシステム知能への移行を担う。

#### 詳細
- ノード：作業単位（エージェント、関数、人間承認など）
- エッジ：ルーティング、分岐、並列、再試行
- 共有状態：ノード間で流れる構造化データ
- パターン：Routing、Parallelization、Orchestrator-Workers、Evaluator-Optimizer など
- LangGraphなどのフレームワークで実装が進む。

#### 主要論文
- Feng et al. (2026). *Graph Engineering in the Era of LLM Agents: From Individual Intelligence to System Intelligence*. arXiv:2608.21156
- Bei et al. (2025). *Graphs Meet AI Agents: Taxonomy, Progress, and Future Opportunities*. arXiv:2506.18019

---

### 6. Agentic Environment Engineering（エージェント環境エンジニアリング）

#### 概要
エージェントが相互作用する環境そのものを設計・合成・評価・進化させる手法。  
静的データセットから、エージェントと共に進化する動的環境への移行。

#### 詳細
- 環境のモデリング（8属性・8ドメイン）
- 合成パラダイム：Symbolic Synthesis / Neural Synthesis
- エージェント進化経路（Memory-centric、Orchestration-centric、Trajectory-centric、Exploration-centric）
- **環境進化の3パラダイム**:
  - Neural-Driven: 環境パラメータをニューラルに調整
  - Difficulty-Driven: カリキュラム学習的に難易度を調整
  - Scaling-Driven: シナリオ多様性や構造をスケール

#### 主要論文
- Li et al. (2026). *Agentic Environment Engineering for Large Language Models: A Survey of Environment Modeling, Synthesis, Evaluation, and Application*. arXiv:2606.12191

---

## 周辺・補完的な概念

### 1. Memory Systems / Cognitive Scaffold（メモリシステム）

#### 概要
短期コンテキストと長期構造化メモリを分離し、経験を蓄積・再利用する仕組み。

#### 詳細
- Episodic / Semantic / Procedural memoryの分類
- エージェントが過去の成功・失敗を参照して改善する基盤
- Context EngineeringやHarnessと密接に関連

#### 主要論文
- *Memory in the Age of AI Agents: A Survey*. arXiv:2512.13564

---

### 2. Multi-Agent Orchestration（マルチエージェントオーケストレーション）

#### 概要
複数の専門エージェントを協調・競合・階層的に動作させる設計パターン。

#### 詳細
- Supervisor-Worker、Handoff、Hierarchical、Swarmなどのパターン
- Graph Engineeringの実装手段として位置づけられることが多い

#### 主要論文
- MetaGPT、AutoGen、CrewAI関連の多数の研究

---

### 3. Observability / Evaluation Engineering（観測性・評価エンジニアリング）

#### 概要
エージェントの動作を追跡・評価・デバッグする仕組み。

#### 詳細
- トレーシング、検証器（Verifier）、成功条件の定義
- ハーネスやループの品質を担保するために不可欠

---

### 4. Scaffold Engineering / Scaffold Evolution（スキャフォールドエンジニアリング）

#### 概要
エージェントの周辺構造（プロンプト、ツール設定、ワークフロー）を自動的に最適化する手法。

#### 詳細
- HarnessやLoopの自動進化と重なる領域
- Meta-Harnessなどの研究が該当

---

### 5. Skill / Tool Engineering（スキル・ツールエンジニアリング）

#### 概要
エージェントが利用可能なツールやスキルを設計・管理する。

#### 詳細
- MCPなどの標準化が進む
- ハーネスの重要な構成要素

---

## 全体像の整理

```
Prompt Engineering
    ↓ 包含・拡張
Context Engineering
    ↓ 包含・拡張
Harness Engineering
    ↓ 包含・拡張
Loop Engineering
    ↓ 包含・拡張
Graph Engineering
    ↓ さらに上位
Agentic Environment Engineering
```

これらは積み重ねの関係にあり、下位レイヤーを無視して上位だけを最適化しても効果は限定的である。

---

## まとめ

エージェントの性能向上において、モデルの重み更新以外の手段は多層的に存在する。  
実務上は、タスクの性質に応じて適切なレイヤー（単一推論ならプロンプト/コンテキスト、長時間実行ならループ、複雑な協調ならグラフ、継続的改善なら環境）を選択することが重要である。

本レポートで挙げた論文は、各概念の最新の体系化を試みるものであり、今後の研究・実装の参考となる。

---

**参考文献一覧（主要）**
- arXiv:2406.06608 (Prompt Report)
- arXiv:2507.13334 (Context Engineering Survey)
- arXiv:2510.04618 (ACE)
- arXiv:2609.00006 (Harness Engineering Anatomy)
- arXiv:2608.21884 (Loop Engineering)
- arXiv:2608.21156 (Graph Engineering)
- arXiv:2606.12191 (Agentic Environment Engineering)

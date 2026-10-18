# 评估：Agent 问诊 vs 单次调用

## 要回答的问题

Agent 只拿到主诉，要靠自己追问把信息问出来。它写出的病历，和「把完整对话一次性交给模型」相比差多少？和「同样只给主诉、但不追问」相比好多少？

## 三个条件

| 条件 | 输入 | 做法 | 代表什么 |
|---|---|---|---|
| **A** 单次调用·完整对话 | 病例里医生问出的全部对话 | 原 `/api/chat` 的 prompt，一次生成 | 现有功能；信息量上限 |
| **B** 单次调用·仅主诉 | 只有一句主诉 | 同上 | 不追问时的下限 |
| **C** Agent·模拟患者 | 只有一句主诉 | LangGraph agent 追问，由模拟患者回答 | 本项目 |

- **模拟患者**：另一个 LLM，只能根据病例原对话回答，没有的信息答「不太清楚」，不许说诊断名（`src/lib/agent/prompts.ts` → `patientPrompt`）。
- **裁判**：仓库原有的评分 prompt，默认 `openai/gpt-4o-mini`，对照 `data/cases.ts` 的标准答案打 4 项分。Phase 0 已改为解析失败直接报错，不再静默给默认分。
- **总分**：四项按原权重加权（去掉「响应速度」后重新归一），0-100。

## 其他指标

- **问出信息占比**（`infoRecall`）：病例原对话里患者的每句话（除第一句主诉），其内容有没有在 agent 的问诊中被问出来（字符二元组重合 ≥ 50%）。衡量「会不会问」。
- **追问轮数、自查打回次数、风险等级**：看图的行为是否符合设计（心内科和内分泌科两个病例应标为 urgent）。
- **耗时、模型调用次数、tokens**：成本。

## 怎么跑

```bash
# 离线：确定性替身，只验证评测流程
npx tsx scripts/eval-agent.ts --mock

# 真实模型（需要 AI_GATEWAY_API_KEY，且网络能访问 ai-gateway.vercel.sh）
npx tsx scripts/eval-agent.ts --model gpt-4o-mini --runs 3
npx tsx scripts/eval-agent.ts --model claude-sonnet --runs 3 --judge openai/gpt-4o-mini
```

结果写入 `docs/agent/eval/results-<tag>.json`（含每次的完整输出和问诊记录）和 `summary-<tag>.md`。

## 当前结果

**真实模型：尚未运行。** 开发环境的网络策略拦截了 `ai-gateway.vercel.sh`，也没有 API key。拿到 key 后执行上面的命令，把 summary 贴到这里。

**离线 mock**（[`eval/summary-mock-2026-09-27.md`](eval/summary-mock-2026-09-27.md)）：三个条件、6 个病例全部跑通，JSON 和汇总表正常生成。mock 模型、mock 患者、mock 裁判都是关键词规则，**分数没有任何医学意义**，只说明评测流程本身是通的。

## 危险信号评测（issue #8 / #4）

测试集：[`evals/red-flags/cases.json`](../../evals/red-flags/cases.json)，72 条。

- **38 条危险信号**，包括容易被否定词规则误杀的说法：不时呼吸困难、无缘无故晕倒、一直不停抽搐、止不住地吐血、是不是呼吸困难、没有发烧但呼吸困难，以及多轮里先答「没」、下一轮说「喘不上气」。
- **19 条明确否认**：没有呼吸困难、否认胸痛大汗、不抽搐、无呕血、否认有明显的呼吸困难等。
- **15 条普通主诉**，用来算误报率。

两套 agent 的规则表不同（src 有「意识改变/晕厥」「不明原因体重下降」，backend 有一级「意识丧失或呼吸停止」），所以每条用例对两边分别写期望规则和等级。某一边没有对应规则的算**覆盖缺口**，单独列出，不计入召回（规则表合并是 #13）。

```bash
npx tsx scripts/eval-red-flags.ts --rules --label baseline   # 规则，确定性，离线
npx tsx scripts/eval-red-flags.ts --model --mock             # backend 分级节点，离线 mock，只验证流程
npx tsx scripts/eval-red-flags.ts --model                    # backend 分级节点，真实 Bedrock（模型 + 规则）
```

`--model` 模式下，backend 没有规则的用例按临床等级算期望（src 的 emergency → 2 级，urgent → 3 级），所以模型把晕倒判成 4 级算漏报。

### 基线（修复前）

规则（[`eval/redflags-summary-rules-baseline-2026-10-18.md`](eval/redflags-summary-rules-baseline-2026-10-18.md)）：

| 实现 | 危险信号召回（规则覆盖的） | 明确否认误报 | 普通主诉误报 | 覆盖缺口 |
|---|---|---|---|---|
| src（Next） | **58.3%**（21/36） | 1/19 | 0/15 | 2 条 |
| backend（Bedrock） | **64.5%**（20/31） | 1/19 | 0/15 | 7 条 |

- 平铺直叙的危险信号全中（src 14/14，backend 15/15）。
- 漏报集中在**不表示否定的「不/无/没」组合词**：不时、不停、不断、止不住、无缘无故、毫无征兆、无力、不知不觉、不舒服、受不了、没完没了、是不是。src 只中 1/14，backend 0/9。
- 转折句「没有发烧但呼吸困难」两边都漏。
- 多轮「没 / 喘不上气」两边都漏：各轮用换行拼起来后，换行不算分句，前一轮的「没」被当成了否定。
- 误报：「否认有明显的呼吸困难」。否定词和症状之间隔了 4 个字，超出了 3 字窗口，就没认出是否认。

| 模式 | 结果 |
|---|---|
| backend 分级，真实 Bedrock（模型 + 规则） | **待运行：需要密钥**（本次开发环境没有 `BEDROCK_ACCESS_KEY_ID` / `BEDROCK_SECRET_ACCESS_KEY`） |
| backend 分级，离线 mock（[summary](eval/redflags-summary-model-mock-baseline-2026-10-18.md)） | 流程跑通，72/72。mock 模型恒定返回 4 级，数字只反映规则部分 |

### 偏差控制

后续的真实模型评测（`eval-agent.ts --runs 3`、`eval-backend.ts`）中，模拟患者和裁判各用一个与被测 agent **不同家族**的模型，避免同一家族的模型互相「对口径」，给自己打高分。

## CrewAI 对照（Phase 5）

`experiments/crewai/crew_eval.py` 用 CrewAI 实现了同一个任务，裁判 prompt 与上面相同（从 `src/lib/prompts.ts` 导出）：

| 条件 | 做法 | 对应 |
|---|---|---|
| CrewAI·完整对话+审核 | 问诊医生根据完整对话写病历 → 审核医生删改 | A 加一个审核角色 |
| CrewAI·委派问诊+审核 | 问诊医生只拿主诉，用 CrewAI 内置的 `Ask question to coworker` 委派工具向「患者」agent 提问，最多 5 次 → 审核医生删改 | C 的 CrewAI 写法 |

```bash
pip install -r experiments/crewai/requirements.txt
python experiments/crewai/crew_eval.py --offline      # 脚本 LLM，验证角色、委派、上下文传递
python experiments/crewai/crew_eval.py --runs 1       # 真实模型（需要 AI_GATEWAY_API_KEY）
```

离线运行（[`eval/crewai-summary-offline-2026-09-27.md`](eval/crewai-summary-offline-2026-09-27.md)）确认：12 次运行全部成功，每个委派问诊都真的调用了一次患者 agent。真实分数待运行。

两种写法的差别，从代码上已经能看出来：
- **追问轮数**：LangGraph 由条件边和计数器决定（最多 4 轮）；CrewAI 由模型在 ReAct 循环里决定，只能用 `max_iter` 间接限制。
- **防编造**：LangGraph 是代码检查原话和事实编号；CrewAI 靠审核 agent 读草稿后自觉删改。
- **危险信号**：LangGraph 有独立节点和短路边；CrewAI 版本里没有对应机制，只能写进 prompt。
- **代码量**：CrewAI 版本的角色和任务定义约 50 行；LangGraph 版本的图、节点、prompt、schema、落地检查和病历渲染约 770 行（不含 mock）。快和可控是这次取舍的两端。

## 预期与要验证的假设

写在跑之前，避免事后找理由：

1. **C 明显高于 B**：同样只有主诉，追问应该带来更准的诊断和更完整的病历。这是 agent 价值的核心证据。
2. **C 接近但低于 A**：A 的对话是医生精心问出来的，agent 问不全是正常的。差距大小取决于问出信息占比。
3. **C 的规范性、完整性不低于 A**：C 的病历由代码按固定格式渲染，每一节都有。
4. **成本**：C 每个病例约 10-15 次模型调用，是 A 的 10 倍以上，耗时也更长。这是要在面试里正面讲的取舍。

## 已知局限

- **样本小**：只有 6 个病例。`--runs 3` 可以看稳定性，但不能下统计结论。
- **裁判是 LLM**：有随机性，也可能偏好某种写法。C 的病历带「依据」和引用编号，可能让裁判打分偏高或偏低，要看 comments 核对。
- **模拟患者会漏答或多答**：它是 LLM，可能说出病例里没有的细节。每次的完整问诊记录都在 JSON 里，可以抽查。
- **infoRecall 是字符重合的近似**：模拟患者改写了原话就可能算漏，偏保守。

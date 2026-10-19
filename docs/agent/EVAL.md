# 评估：Agent 问诊 vs 单次调用

## 要回答的问题

Agent 只拿到主诉，要靠自己追问把信息问出来。它写出的病历，和「把完整对话一次性交给模型」相比差多少？和「同样只给主诉、但不追问」相比好多少？

## 三个条件

| 条件 | 输入 | 做法 | 代表什么 |
|---|---|---|---|
| **A** 单次调用·完整对话 | 病例里医生问出的全部对话 | 原 `/api/chat` 的 prompt，一次生成 | 现有功能；信息量上限 |
| **B** 单次调用·仅主诉 | 只有一句主诉 | 同上 | 不追问时的下限 |
| **C** Agent·模拟患者 | 只有一句主诉 | LangGraph agent 追问，由模拟患者回答 | 本项目 |

- **模拟患者**：另一个 LLM，只能根据病例原对话回答，没有的信息答「不太清楚」，不许说诊断名（`src/lib/sim/patient.ts` → `patientPrompt`）。
- **裁判**：仓库原有的评分 prompt，对照 `data/cases.ts` 的标准答案打 4 项分。Phase 0 已改为解析失败直接报错，不再静默给默认分。
- **偏差控制**（#8）：模拟患者和裁判各用一个与被测 agent **不同家族**的模型，两者之间也不同家族（`--patient` / `--judge` 默认 `auto`，自动挑选；手动指定了同家族的模型会直接报错退出）。以前模拟患者和 agent 用同一个模型，默认裁判 `openai/gpt-4o-mini` 又和默认 agent 同属 OpenAI，可能「自己人给自己人打高分」。
- **总分**：四项按原权重加权（去掉「响应速度」后重新归一），0-100。

## 其他指标

- **问出信息占比**（`infoRecall`）：病例原对话里患者的每句话（除第一句主诉），其内容有没有在 agent 的问诊中被问出来（字符二元组重合 ≥ 50%）。衡量「会不会问」。
- **追问轮数、自查打回次数、风险等级**：看图的行为是否符合设计（心内科和内分泌科两个病例应标为 urgent）。
- **耗时、模型调用次数、tokens**：成本。

## 怎么跑

```bash
# 离线：确定性替身，只验证评测流程
npx tsx experiments/next-agent/eval-agent.ts --mock

# 真实模型（需要 AI_GATEWAY_API_KEY，且网络能访问 ai-gateway.vercel.sh）
npx tsx experiments/next-agent/eval-agent.ts --model gpt-4o-mini --runs 3
npx tsx experiments/next-agent/eval-agent.ts --model claude-sonnet --runs 3   # 患者、裁判自动选 OpenAI / DeepSeek
```

结果写入 `docs/agent/eval/results-<tag>.json`（含每次的完整输出和问诊记录）和 `summary-<tag>.md`。

## 当前结果

| 运行 | 结果 |
|---|---|
| `eval-agent.ts --runs 3`，真实模型 | **待运行：需要密钥**（本次开发环境没有 `AI_GATEWAY_API_KEY`） |
| `eval-agent.ts --mock`，修复前（[summary](eval/summary-mock-2026-09-27.md)） | 6/6 跑通；C 条件总分 85.7；事实 27 条，原话校验丢弃 0 条 |
| `eval-agent.ts --mock`，修复后（[summary](eval/summary-mock-2026-10-18.md)） | 6/6 跑通；C 条件总分 **85.7（不变）**；事实 26 条，丢弃 1 条（患者答的「会的」：2 个字，又不是整轮回答，按 #5 的规则丢弃） |

mock 模型、mock 患者、mock 裁判都是关键词规则，**分数没有任何医学意义**，只说明评测流程本身是通的，以及 #5 收紧原话校验后没有误杀 mock 的正常事实。

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

### 修复后（#4 之后）与前后对比

规则（[`eval/redflags-summary-rules-after-2026-10-18.md`](eval/redflags-summary-rules-after-2026-10-18.md)）：

| 实现 | 危险信号召回（修复前 → 后） | 明确否认误报 | 普通主诉误报 | 覆盖缺口 |
|---|---|---|---|---|
| src（Next） | 58.3% → **100%**（36/36） | 1/19 → **0/19** | 0/15 → 0/15 | 2 条（不变） |
| backend（Bedrock） | 64.5% → **100%**（31/31） | 1/19 → **0/19** | 0/15 → 0/15 | 7 条（不变） |

按类别（src，修复前 → 后）：不表示否定的组合词 1/14 → 14/14；转折句 1/2 → 2/2；多轮 1/2 → 2/2；问句 0/1 → 1/1；平铺直叙 14/14 → 14/14。

| 模式 | 修复前 | 修复后 |
|---|---|---|
| backend 分级，真实 Bedrock（模型 + 规则） | 待运行：需要密钥 | 待运行：需要密钥 |
| backend 分级，离线 mock（模型恒为 4 级，只看规则） | 召回 52.6%，否认/普通误判急诊 2.9% | 召回 **81.6%**，误判急诊 **0%**（剩下的是 backend 规则表的 7 条覆盖缺口，规则表合并留给 #13） |

### 规则表合并后（#13）

两套规则表合并成 `shared/safety/red-flags.ts` 里的一张（四级），补上了 backend 原来缺的晕厥、半边身子无力、不明原因体重下降。用例的期望也改成一套（[`eval/redflags-summary-rules-unified-2026-10-19.md`](eval/redflags-summary-rules-unified-2026-10-19.md)）：

| | 危险信号召回 | 等级一致 | 明确否认误报 | 普通主诉误报 | 覆盖缺口 |
|---|---|---|---|---|---|
| 合并后的规则表 | **100%**（38/38） | 100% | 0/19 | 0/15 | **0 条**（原来 backend 7 条、src 2 条） |
| backend 分级，离线 mock（模型恒为 4 级，只看规则） | 召回 81.6% → **100%** | | 误判急诊 0% | | |

原话校验丢弃数（#5）：`eval-agent --mock` 共 27 条事实，丢弃 0 → 1 条（见上）。backend 的丢弃数现在由 `eval-backend.ts` 统计，离线 mock 平均 0.2 条/次（resp-001 有 1 条）。修复前没有这项统计，所以 backend 没有修复前的数字。

## Backend 评测（`scripts/eval-backend.ts`）

在 6 个演示病例上跑 backend 的完整问诊：

- **agent**：Bedrock 上的 Claude，快档负责提取、分级、改写问题，慢档负责写病历、自查。
- **模拟患者**：默认是 Bedrock 上的 Amazon Nova Pro（`bedrock:us.amazon.nova-pro-v1:0`）。
- **裁判**：默认是 Bedrock 上的 DeepSeek V3.1（`bedrock:deepseek.v3-v1:0`）。三者属于三个不同的模型家族，脚本会检查。也可以传 AI Gateway 的模型 id。
- **评分**：裁判**对照实际发生的对话**评价病历的完整性和准确性，并逐条列出找不到依据的陈述。不对照标准诊断，因为 backend 本来就不写诊断。

每次问诊都记录：模型调用次数、输入/输出 tokens、成本、模型耗时、端到端耗时、追问轮数、原话校验丢弃数。

- **用量按问诊统计**：以前 `llm.usage` 是整个进程共用一个数组（`backend/src/llm.ts`），几个问诊同时跑时没法区分。现在每条用量记录都带上问诊编号（AsyncLocalStorage），`service.usageFor(id)` 按问诊汇总。
- **成本**：按 `PRICE_PER_MTOK` 价格表计算（Anthropic 官方标价：Haiku 4.5 $1/$5、Sonnet 4.6 $3/$15，单位为每百万 tokens 的输入/输出价格）。Bedrock 的计价以 AWS 价格页为准。

```bash
npx tsx scripts/eval-backend.ts --mock     # 离线
npx tsx scripts/eval-backend.ts --runs 3   # 需要 BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY
```

| 运行 | 结果 |
|---|---|
| 真实 Bedrock | 见下面「真实 Bedrock 评测」 |
| 离线 mock（[summary](eval/backend-summary-mock-2026-10-18.md)） | 6/6 跑通，平均 3.5 轮、14.5 次调用。mock 没有 tokens，也不定价，所以成本列为空。mock 裁判只看患者原话有没有进入病历，数字只说明流程是通的 |

## 真实 Bedrock 评测（2026-10-19）

条件：us-east-2；agent 快档 Claude Haiku 4.5、慢档 Claude Sonnet 4.6；模拟患者 Amazon Nova Pro；裁判 DeepSeek V3.1；6 个演示病例 × 3 次。成本按 Anthropic 标价估算。

### 完整问诊（最终一轮，[追问改写](eval/backend-summary-bedrock-2026-10-19.md) / [模板问法](eval/backend-summary-bedrock-template-2026-10-19.md)）

| | 成功 | 完整性 | 准确性 | 无依据陈述（条/次） | 模型调用 | 成本/次 | 端到端耗时 | 引用覆盖率 | 引用准确率 |
|---|---|---|---|---|---|---|---|---|---|
| 模型改写追问 | 17/18 | 83.8 | 86.9 | 4.4 | 16.1 | $0.145 | 62s | 100% | 87.1% |
| 模板问法 | 18/18 | **92.5** | **92.2** | 3.7 | 13.6 | $0.147 | 63s | 100% | 85.4% |

只看正常完成的问诊（三轮都算）：两种问法的完整性和准确性基本相同（最终一轮 92.3 / 95.2 对 92.9 / 94.1），模板问法每次问诊少 3～4 次模型调用。因此默认改为模板问法（`AGENT_PHRASING=model` 可以切回）。表里模型改写的平均分偏低，是因为有两次被规则误判成急诊（已修复，见下）。

### 危险信号分级（[summary](eval/redflags-summary-model-bedrock-2026-10-19.md)，79 条用例，Haiku 4.5）

| | 仅模型 | 模型 + 规则（图里实际用的） |
|---|---|---|
| 危险信号召回（等级不低于期望） | 68.3% | **100%** |
| 否认、普通主诉被判急诊 | 0% | 0% |
| 等级完全一致 | 57.0% | 73.4% |

模型单独会漏判、低判三分之一的危险信号，规则兜底后全部识别。

### 每轮延迟（#10，[优化前](eval/latency-summary-bedrock-before-2026-10-19.md) / [优化后](eval/latency-summary-bedrock-after-2026-10-19.md) / [模板问法](eval/latency-summary-bedrock-after-template-2026-10-19.md)）

同样的 8 个场景、同样的脚本患者，在真实 Bedrock 上：

| | 追问轮平均耗时 | 追问轮调用 | 追问轮成本 | 结束轮（写病历和自查） | 开场即急诊 |
|---|---|---|---|---|---|
| 优化前（串行） | 4.74s | 3 | $0.0064 | 41.3s | 2 次调用 |
| 并行改写 | **3.54s（-25%）** | 3 | $0.0064 | 37.9s | **0 次** |
| 模板问法 | **3.51s（-26%）** | **2** | **$0.0049（-24%）** | 39.3s | 0 次 |

结束轮最慢：慢档写病历加自查，自查不通过还要重写，P90 超过 1 分钟。这是下一步优化的重点。

### 真实评测发现并已修复的问题

- 规则把否认误判成危险信号，问诊被提前结束：否认覆盖一串症状（「没有喘不上气、呼吸困难」「没有出现嘴歪、一边手脚没力气，或者说话不清楚」）、否认词和症状之间隔着「特别」「注意到」「到」「出」。这些原话都加进了 `evals/red-flags/cases.json`（现在 85 条，召回 42/42，否认误报 0/28）；`tests/red-flags.test.ts` 会把三轮真实评测的全部患者原话重放一遍，确认不再触发Ⅰ、Ⅱ级规则。
- 「头痛…伴眩晕、恶心」被分到腹痛模板：现在按最先说到的症状选模板。
- 慢档写病历偶尔把嵌套对象写成带未转义引号的 JSON 字符串，重试也失败：现在先修复再校验，并要求文本用「」。病历的输出上限也从 1500 提到 4096 tokens。

前两轮的结果保留在 `eval/*bedrock-run1*`、`eval/*bedrock-run2*`。最终一轮之后修复的规则用真实原话离线验证（规则是确定性的）。

已知局限：每个病例只跑 3 次；裁判也是模型；模拟患者偶尔把 `</thinking>` 之类的标记带进回答；36 次问诊里有 1 次快档模型连续 4 次没有调用工具（问诊标记为失败，可以重试）。

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

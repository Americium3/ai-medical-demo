# LangChain / LangGraph / CrewAI 对比笔记

写于 Phase 1。三个 demo 在 `experiments/`，都能离线运行。

## 一句话定位

| | 定位 | 控制流由谁决定 | 语言 |
|---|---|---|---|
| **LangChain** | 组件库：模型接口、prompt 模板、结构化输出、工具、LCEL 管道 | 你写的代码（线性链） | Python / JS |
| **LangGraph** | 在 LangChain 之上的状态机：节点 + 边 + 共享状态，支持条件分支、循环、中断恢复 | 你画的图（显式） | Python / JS |
| **CrewAI** | 多角色协作：定义 Agent（角色、目标、背景）和 Task，由 Crew 编排 | 框架 + LLM（隐式） | 仅 Python |

LangGraph 不是 LangChain 的替代品：本项目里节点内部用 LangChain 调模型和做结构化输出，节点之间的流转交给 LangGraph。

## 动手后的观察

**LangChain（demo 1）**
- `withStructuredOutput(zodSchema)` 是最有用的一块：模型输出直接变成有类型的对象，校验失败会抛错，不用自己写 `JSON.parse` 和正则。原项目评分接口的问题就是自己正则抽 JSON，失败时返回了默认分。
- `method` 要显式选。真实模型用 `functionCalling`，兼容性最好（经 AI Gateway 转发到 Claude、DeepSeek 也能用）；纯文本的假模型只能用 `jsonMode`。
- 离线测试可以用 `FakeListChatModel`，但它不会产生 tool call，所以测复杂流程时我改成自己注入一个确定性的 mock（见 `src/lib/agent/mock-llm.ts`）。

**LangGraph（demo 2）**
- 状态每个键都可以定义 reducer（追加还是覆盖），节点只返回局部更新，图的执行轨迹天然就能按节点流式推出去（`streamMode: "updates"`），这正好拿来做前端的执行轨迹。
- 条件边加计数器就是「有上限的循环」，比在 prompt 里要求模型「最多重试两次」可靠。
- 坑：**节点名不能和状态键同名**（`draft` 节点和 `draft` 字段冲突，直接抛错）。
- `interrupt()` 能把图暂停下来等人回答，但要配 checkpointer 存状态。`MemorySaver` 只在进程内存里，Vercel 的函数调用结束就没了。线上要么接持久化 checkpointer（Postgres/Redis），要么像本项目一样把每次请求设计成无状态：前端带着完整对话来，图从头推一遍。

**CrewAI（demo 3）**
- 写起来最快：角色、目标、背景都是自然语言，`context=[draft]` 一行就把上一个任务的输出传给下一个。
- 控制流在框架里：agent 内部是 ReAct 循环（Thought / Final Answer），重试几次、什么时候停，都不在你手里，调试要看日志。
- 没有 JS 版。要上 Vercel 只能走 Python 函数，而 `crewai` 依赖很重（chromadb、litellm、opentelemetry 等），很可能超过函数体积限制（未实测）。所以本项目只把它当对比实验，不部署。

## 为什么主体选 LangGraph

问诊这个任务的形状是：**追问循环**（信息不够就继续问）+ **硬分支**（危险信号直接转急诊，不能让模型「商量」）+ **有上限的自查回环**（不通过就重写，最多两次）。

- 这些规则需要确定地执行，而且要能在 UI 里逐步展示出来：LangGraph 的显式图正合适。
- CrewAI 的角色协作更适合开放式任务（调研、写作），在这里「审核医生」能不能真的拦住编造，取决于 LLM 自觉，不可测。
- 部署层面，LangGraph.js 直接跑在 Next.js API route 里，和现有 AI SDK 共用一个 AI Gateway key。

Phase 5 用 CrewAI 把同一个任务又做了一遍，在同样的病例和评分裁判下对比，结果见 `EVAL.md`。

# AI 问诊助手 · 预问诊 Agent

患者见医生之前，Agent 按问诊模板追问、先用规则查危险信号，最后写一份门诊病历草稿给医生，每条给医生的建议都标注诊疗指南出处。Agent 不下诊断。

## 架构

```mermaid
flowchart LR
    Browser["浏览器 /agent"] -->|"/api/agent<br/>Next.js（Vercel）"| API["backend HTTP API<br/>鉴权 · 限流 · 问诊锁"]
    API --> Graph
    subgraph Graph["LangGraph 问诊图（backend/src/graph.ts）"]
        direction LR
        screen["screen<br/>规则筛查"] -->|Ⅰ/Ⅱ级| emergency["emergency<br/>提示急诊"]
        screen --> understand["understand<br/>更新记录表"]
        understand --> triage["triage<br/>危险分级"]
        understand --> phrase["phrase<br/>改写追问"]
        triage -->|还要问| ask["ask → wait<br/>暂停等回答"]
        triage -->|问完了| retrieve["retrieve<br/>检索指南"]
        triage -->|Ⅰ/Ⅱ级| emergency
        retrieve --> draft["draft<br/>写病历"] --> check["check<br/>自查"]
        check -->|不通过 ≤2 次| draft
        ask -.->|患者回答| screen
    end
    Graph --> Bedrock["AWS Bedrock<br/>快档 Haiku 4.5 · 慢档 Sonnet 4.6"]
    Graph --> PG[("PostgreSQL<br/>问诊状态")]
    API --> Redis[("Redis<br/>锁和限流")]
```

部署形态：ECS Fargate + RDS + ElastiCache，私有子网经 VPC 终端节点访问 Bedrock（[deploy/aws/](deploy/aws/README.md)）。单机演示用 SQLite 和内存，`npm run demo` 即可。

## 关键设计决策

| 决策 | 原因 | 详见 |
|---|---|---|
| 流程由代码控制（workflow），不是 ReAct agent | 问诊步骤固定，需要模型判断的是每一步的内容，不是顺序；所有循环都有上限，最坏 20 次模型调用 | [DESIGN.md §6、§7.4](docs/agent/DESIGN.md) |
| 问什么由规划器决定，模型只改写措辞 | 选题、去重、停止条件都是确定性的，可测试 | §7.3 |
| 规则先于模型，只升不降 | Ⅰ、Ⅱ级危险信号不调用模型就提示急诊；规则处理否认（「没有胸痛」不触发） | §3.3 |
| 记录表只接受能对上患者原话的内容 | 防编造：原话必须逐字出现、不能太短、与结论相关、不是患者否认的内容 | §7.2 |
| 不下诊断，建议必须引用指南 | 给医生的可能原因和建议检查都要标注检索到的指南片段，自查拦截没有出处的建议 | [backend/README.md](backend/README.md#指南检索12) |
| checkpointer 保存状态，`interrupt()` 暂停 | 问诊可以中断后在另一个进程继续；部署时换成 PostgreSQL，实例无状态 | §8 |
| 快、慢两档模型 | 每轮追问只用快档，写病历和自查才用慢档 | §12.4 |

## 评测结果

| 评测 | 结果 | 条件 |
|---|---|---|
| 危险信号规则（72 条用例） | 召回 **100%**（38/38），明确否认误报 **0/19**，普通主诉误报 0/15 | 确定性，离线（[EVAL.md](docs/agent/EVAL.md#规则表合并后13)） |
| 修复否认漏判（#4） | 召回 58.3% / 64.5% → 100% | 同上 |
| 每轮追问延迟（#10） | 2.92s → **2.05s**；开场即急诊 2 次模型调用 → **0 次** | 模拟计时，调用次数准确（[backend/README.md](backend/README.md#每轮延迟和成本10)） |
| 指南引用（#12） | 引用覆盖率 100%，引用准确率 91.7% | 离线替身 |
| 真实 Bedrock | PR #2 时完整跑过 10 次，全部生成病历；之后的改动和上面各项的真实数字**待运行：需要密钥** | |

离线替身的数字只证明流程是通的，不代表模型水平。

## 页面

| 页面 | 说明 |
|---|---|
| **`/agent`** | **预问诊 Agent**：调用 `backend/`，显示追问、危险分级、记录表、执行轨迹和病历草稿；可以让模拟患者按病例自动回答 |
| `/consultation` | 问诊模拟：手动输入医患对话，一次生成结构化病历 |
| `/cases` | 6 个多科室病例，带标准答案 |
| `/comparison` | 多模型对比，由 LLM 裁判打分 |

![/agent：追问、记录表、执行轨迹和带指南出处的病历草稿（离线替身模型）](docs/agent/img/agent-backend.png)

## 本地运行

```bash
npm ci
cp .env.example .env.local   # 填入 AI_GATEWAY_API_KEY（/consultation、/comparison 用）

# 终端 1：问诊后端（没有 Bedrock 密钥时用离线替身模型）
API_KEYS=dev-key npm run backend:server
# 终端 2：网页，/agent 通过 BACKEND_URL 调后端
BACKEND_URL=http://localhost:8787 BACKEND_API_KEY=dev-key npm run dev
```

只看后端：`npm run demo`，在 http://localhost:8787 打开它自带的问诊页面。

```bash
npm test             # 全部离线
npm run typecheck
npm run lint
npm run test:integration   # 需要 PostgreSQL 和 Redis，见 deploy/aws/README.md
```

## 文档

- [设计文档](docs/agent/DESIGN.md)：问诊流程、模板、记录表、分级、接口与成本控制
- [backend/README.md](backend/README.md)：接口、配置、延迟和成本、指南检索、部署、默认模型
- [评测](docs/agent/EVAL.md)、[事故复盘](docs/agent/postmortems/)
- [部署到 AWS](deploy/aws/README.md)
- [框架对比笔记](docs/agent/FRAMEWORKS.md)、[3 分钟讲解稿](docs/agent/PITCH.md)、[Roadmap](docs/agent/ROADMAP.md)

## 早期原型与框架实验

- `experiments/next-agent/`：最早的 Next.js 版问诊 Agent（Gateway 模型、鉴别诊断、无状态），已不在生产路径上，保留用来复现「agent 对比单次调用」的评测。见 [README](experiments/next-agent/README.md) 和 [ARCHITECTURE.md](docs/agent/ARCHITECTURE.md)。
- `experiments/`：LangChain、LangGraph、CrewAI 的最小 demo，以及 CrewAI 版的同任务实现。见 [experiments/README.md](experiments/README.md)。

---

本项目为技术演示，不构成医疗建议。

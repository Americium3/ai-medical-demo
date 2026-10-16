# Roadmap 与完成情况

面试题：基于现有项目，选一个能在 Vercel 上跑的，做一个案例，熟悉 LangChain / LangGraph / CrewAI。

选型：`ai-medical-demo`。原本的问诊是「用户手动输入整段医患对话，模型一次生成病历」，没有追问、没有自查。本项目在上面加了一个 LangGraph 问诊 agent。

| Phase | 内容 | 状态 | 产出 |
|---|---|---|---|
| 0 基线 | 修复对比页流解析（v4 `0:` 格式 vs v6 SSE，导致回答永远为空）和评分接口静默返回默认分 | ✅ | `src/lib/ui-stream.ts`、`src/lib/scoring.ts`、`tests/phase0.test.ts` |
| 1 熟悉框架 | 三个最小 demo，离线可跑；对比笔记 | ✅ | `experiments/`、`FRAMEWORKS.md` |
| 2 Agent 主干 | LangGraph 八个节点、两个有上限的环、急诊短路；SSE API；离线 mock | ✅ | `src/lib/agent/`、`src/app/api/agent/`、`tests/agent.test.ts` |
| 3 前端 | `/agent`：对话、执行轨迹、图、病历、评分、模拟患者 | ✅ | `src/app/agent/`、`img/` |
| 4 评估 | 三条件对比（完整对话 / 仅主诉 / agent）+ 信息召回、成本 | ✅ 流程 · ⏳ 真实数字 | `scripts/eval-agent.ts`、`EVAL.md` |
| 5 对比与收尾 | CrewAI 同任务两种写法（含委派问诊）+ 同一裁判；文档与讲解稿 | ✅ 代码 · ⏳ 真实数字 | `experiments/crewai/crew_eval.py`、`ARCHITECTURE.md`、`PITCH.md` |

## 待完成（需要 API key）

开发环境的网络策略拦截了 `ai-gateway.vercel.sh`，也没有 key，所以所有真实模型调用都没跑过。以下已用离线 mock 和本地假 OpenAI 服务验证过流程，但需要真实环境确认：

1. `npx tsx scripts/eval-agent.ts --model gpt-4o-mini --runs 3`，把结果填进 `EVAL.md`
2. `python experiments/crewai/crew_eval.py --runs 1`，填进 `EVAL.md` 的 CrewAI 部分
3. Vercel preview 上手动走一遍 `/agent`（Preview 环境需要配置 `AI_GATEWAY_API_KEY`）
4. 确认 AI Gateway 的 OpenAI 兼容接口对 `anthropic/*`、`deepseek/*` 模型的 tool calling 都能用；不行的话把 `withStructuredOutput` 的 `method` 换成 `jsonMode`

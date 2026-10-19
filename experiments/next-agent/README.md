# 早期原型：Next.js 版问诊 Agent

> **这是早期原型，不在生产路径上。** `/agent` 页面和 `/api/agent` 现在都走 `backend/`（#13）。这里的代码只用来复现 Phase 2～4 的结果（agent 对比单次调用的评测），不再加功能。

和 `backend/` 的区别：

| | 原型（这里） | backend（生产） |
|---|---|---|
| 目标 | 鉴别诊断、处置建议 | 预问诊，只写病历草稿，不下诊断 |
| 模型 | Vercel AI Gateway（`src/lib/sim/gateway.ts`） | AWS Bedrock（`backend/src/llm.ts`） |
| 状态 | 无状态，每次请求带完整对话 | checkpointer 保存，可中断后继续 |
| 危险分级 | 三级（routine / urgent / emergency） | 四级（Ⅰ～Ⅳ） |

两者共用同一张危险信号规则表和同一套原话校验（`shared/safety/`）。原型的三级是从四级换算的：Ⅰ、Ⅱ级 → emergency，Ⅲ级 → urgent，见 `lib/red-flags.ts`。

```bash
npx tsx experiments/next-agent/eval-agent.ts --mock      # 离线跑通评测流程
npx tsx --test "experiments/next-agent/tests/**/*.test.ts"  # 也包含在 npm test 里
```

结构：`lib/` 是图和提示词（原 `src/lib/agent/`），`tests/` 是原型的测试，`eval-agent.ts` 是三条件评测（原 `scripts/eval-agent.ts`）。图的说明见 [`docs/agent/ARCHITECTURE.md`](../../docs/agent/ARCHITECTURE.md)。

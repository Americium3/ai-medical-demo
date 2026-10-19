# Latency bench bedrock-after-template-2026-10-19

| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |
|---|---|---|---|---|---|
| 首轮（主诉） | 7 | 3.63s | 4.17s | 2.00 | $0.00470 |
| 追问轮 | 12 | 3.51s | 3.83s | 2.00 | $0.00490 |
| 结束轮（写病历或急诊） | 8 | 39.25s | 69.49s | 6.00 | $0.10055 |

| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |
|---|---|---|---|---|
| resp-001 | completed | 4 | 15 | $0.1611 |
| gastro-001 | completed | 5 | 15 | $0.1421 |
| cardio-001 | completed | 4 | 14 | $0.1749 |
| neuro-001 | completed | 5 | 15 | $0.1231 |
| ortho-001 | completed | 3 | 11 | $0.0988 |
| endo-001 | completed | 3 | 14 | $0.1920 |
| emergency-opening | emergency | 1 | 0 | $0.0000 |
| emergency-later | emergency | 2 | 2 | $0.0041 |
| **平均** | | 3.4 | 10.8 | $0.1120 |

单次调用的最大输入 tokens（估算）：extract 1720，triage 1484，note 3774，review 3182

# Latency bench bedrock-before-2026-10-19

| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |
|---|---|---|---|---|---|
| 首轮（主诉） | 7 | 4.80s | 5.80s | 3.00 | $0.00628 |
| 追问轮 | 14 | 4.74s | 5.14s | 3.00 | $0.00644 |
| 结束轮（写病历或急诊） | 8 | 41.25s | 78.96s | 7.75 | $0.11675 |

| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |
|---|---|---|---|---|
| resp-001 | completed | 5 | 19 | $0.1246 |
| gastro-001 | completed | 5 | 23 | $0.2361 |
| cardio-001 | completed | 5 | 24 | $0.2584 |
| neuro-001 | completed | 5 | 22 | $0.1673 |
| ortho-001 | completed | 3 | 12 | $0.0850 |
| endo-001 | completed | 3 | 18 | $0.1811 |
| emergency-opening | emergency | 1 | 2 | $0.0049 |
| emergency-later | emergency | 2 | 5 | $0.0108 |
| **平均** | | 3.6 | 15.6 | $0.1335 |

单次调用的最大输入 tokens（估算）：extract 1701，triage 1459，phrase 1095，note 3193，review 2666

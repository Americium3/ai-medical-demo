# Latency bench bedrock-after-2026-10-19

| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |
|---|---|---|---|---|---|
| 首轮（主诉） | 7 | 3.63s | 3.90s | 3.00 | $0.00624 |
| 追问轮 | 14 | 3.54s | 4.19s | 3.00 | $0.00643 |
| 结束轮（写病历或急诊） | 8 | 37.89s | 81.88s | 6.13 | $0.10362 |

| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |
|---|---|---|---|---|
| resp-001 | completed | 5 | 21 | $0.1997 |
| gastro-001 | completed | 5 | 19 | $0.1292 |
| cardio-001 | completed | 5 | 24 | $0.2734 |
| neuro-001 | completed | 5 | 19 | $0.1278 |
| ortho-001 | completed | 3 | 14 | $0.1266 |
| endo-001 | completed | 3 | 12 | $0.1003 |
| emergency-opening | emergency | 1 | 0 | $0.0000 |
| emergency-later | emergency | 2 | 3 | $0.0057 |
| **平均** | | 3.6 | 14.0 | $0.1203 |

单次调用的最大输入 tokens（估算）：extract 1698，phrase 1095，triage 1554，note 3560，review 3252

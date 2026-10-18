# Latency bench simulated-after-2026-10-18

> 模拟计时：每次模型调用按 PROFILE 假设的首字延迟和输出速度真实等待（快档 0.6s + 150 tok/s，慢档 1.2s + 70 tok/s），tokens 按字符估算、按 Haiku 4.5 / Sonnet 4.6 标价计费。调用次数是准确的，秒数和美元是估算。

| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |
|---|---|---|---|---|---|
| 首轮（主诉） | 7 | 2.08s | 2.45s | 3.00 | $0.00320 |
| 追问轮 | 15 | 2.05s | 2.23s | 3.00 | $0.00337 |
| 结束轮（写病历或急诊） | 8 | 5.63s | 8.73s | 3.00 | $0.00931 |

| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |
|---|---|---|---|---|
| resp-001 | completed | 5 | 16 | $0.0275 |
| gastro-001 | completed | 5 | 16 | $0.0254 |
| cardio-001 | completed | 4 | 13 | $0.0251 |
| neuro-001 | completed | 5 | 16 | $0.0238 |
| ortho-001 | completed | 4 | 13 | $0.0214 |
| endo-001 | completed | 4 | 13 | $0.0210 |
| emergency-opening | emergency | 1 | 0 | $0.0000 |
| emergency-later | emergency | 2 | 3 | $0.0032 |
| **平均** | | 3.8 | 11.3 | $0.0184 |

单次调用的最大输入 tokens（估算）：extract 1093，triage 1006，phrase 718，note 1261，review 1217

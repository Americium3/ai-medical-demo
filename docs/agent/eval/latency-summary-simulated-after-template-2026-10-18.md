# Latency bench simulated-after-template-2026-10-18

> 模拟计时：每次模型调用按 PROFILE 假设的首字延迟和输出速度真实等待（快档 0.6s + 150 tok/s，慢档 1.2s + 70 tok/s），tokens 按字符估算、按 Haiku 4.5 / Sonnet 4.6 标价计费。调用次数是准确的，秒数和美元是估算。

| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |
|---|---|---|---|---|---|
| 首轮（主诉） | 7 | 1.92s | 2.23s | 2.00 | $0.00225 |
| 追问轮 | 15 | 1.93s | 2.15s | 2.00 | $0.00240 |
| 结束轮（写病历或急诊） | 8 | 5.64s | 8.73s | 3.00 | $0.00931 |

| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |
|---|---|---|---|---|
| resp-001 | completed | 5 | 12 | $0.0237 |
| gastro-001 | completed | 5 | 12 | $0.0215 |
| cardio-001 | completed | 4 | 10 | $0.0222 |
| neuro-001 | completed | 5 | 12 | $0.0199 |
| ortho-001 | completed | 4 | 10 | $0.0186 |
| endo-001 | completed | 4 | 10 | $0.0182 |
| emergency-opening | emergency | 1 | 0 | $0.0000 |
| emergency-later | emergency | 2 | 2 | $0.0022 |
| **平均** | | 3.8 | 8.5 | $0.0158 |

单次调用的最大输入 tokens（估算）：extract 1093，triage 1006，note 1261，review 1217

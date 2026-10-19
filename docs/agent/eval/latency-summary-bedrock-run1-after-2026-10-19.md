# Latency bench bedrock-after-2026-10-19

> 第一次真实 Bedrock 运行（提交 f156558）：规则的否认列表误报和病历 token 上限两个问题修复之前。修复后的结果见同名去掉 run1 的文件。

| 轮次 | 次数 | 平均耗时 | P90 耗时 | 模型调用/轮 | 成本/轮 |
|---|---|---|---|---|---|
| 首轮（主诉） | 7 | 4.00s | 6.08s | 3.00 | $0.00638 |
| 追问轮 | 13 | 3.55s | 3.86s | 3.00 | $0.00640 |
| 结束轮（写病历或急诊） | 8 | 33.20s | 67.66s | 5.63 | $0.08880 |

| 场景 | 结果 | 轮数 | 模型调用 | 成本/次 |
|---|---|---|---|---|
| resp-001 | completed | 4 | 16 | $0.1221 |
| gastro-001 | completed | 5 | 19 | $0.1314 |
| cardio-001 | completed | 5 | 21 | $0.2018 |
| neuro-001 | completed | 5 | 18 | $0.1127 |
| ortho-001 | completed | 3 | 13 | $0.1029 |
| endo-001 | completed | 3 | 15 | $0.1617 |
| emergency-opening | emergency | 1 | 0 | $0.0000 |
| emergency-later | emergency | 2 | 3 | $0.0056 |
| **平均** | | 3.5 | 13.1 | $0.1048 |

单次调用的最大输入 tokens（估算）：extract 1697，phrase 1096，triage 1456，note 3680，review 3201

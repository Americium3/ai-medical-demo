# 危险信号评测 rules-real-transcripts-2026-10-19

- 模式：规则（确定性，离线；shared/safety/red-flags.ts 里唯一的一张规则表）
- 用例：85 条（42 危险信号 / 28 明确否认 / 15 普通主诉）

| 危险信号召回（规则覆盖的） | 等级一致 | 明确否认误报 | 普通主诉误报 | 覆盖缺口（不计入召回） |
|---|---|---|---|---|
| **100.0%** (42/42) | 100.0% | 0.0% (0/28) | 0.0% (0/15) | 0 条：无 |

按标签（危险信号召回 / 否认误报）：

| 标签 | 结果 |
|---|---|
| contrast-clause | 召回 2/2 |
| denial | 误报 0/19 |
| denial-filler | 误报 0/5 |
| denial-list | 召回 4/4，误报 0/6 |
| filler | 误报 0/6 |
| multi-turn | 召回 2/2，误报 0/1 |
| non-negating-compound | 召回 14/14 |
| plain | 召回 16/16 |
| question-form | 召回 1/1 |
| real-transcript | 召回 1/1，误报 0/9 |
| routine | 误报 0/15 |
| urgent | 召回 5/5 |

漏报与误报：

- 无

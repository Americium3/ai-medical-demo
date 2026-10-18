# 问诊Agent后端演示

本目录是问诊Agent的后端演示，使用LangGraph编排问诊流程，模型通过AWS Bedrock调用。演示以命令行方式运行，也可以作为HTTP服务启动。

## 一、与设计文档的对应关系

| 设计文档 | 实现位置 |
|---|---|
| 第三部分 危险分级（四级） | `src/triage.ts`：规则只能把等级调得更紧急，不能调低 |
| 第七部分 问诊模板 | `src/templates.ts`：通用要点加胸痛、腹痛、头痛、咳嗽发热四类模板 |
| 第七部分 问诊记录表、选题规则、停止条件 | `src/record.ts`、`src/planner.ts` |
| 第八部分 会话记忆与防重复追问 | `src/graph.ts` 中的 `wait` 节点暂停问诊，状态按问诊编号保存在SQLite中；`src/planner.ts` 的三层去重 |
| 第九部分 接口与安全 | `src/server.ts`、`src/security.ts` |
| 第十二部分 成本控制 | 追问轮数和自查次数有上限；`src/llm.ts` 按步骤选用快、慢两档模型；每个接口密钥有每日问诊上限 |

问诊流程如下：

```
setup → screen ─┬─ 规则命中Ⅰ级或Ⅱ级 → emergency（不调用模型）
          ▲     └─ understand ─┬─ triage ─┬─ Ⅰ级或Ⅱ级 → emergency（提示急诊，结束；改写好的问题丢弃）
          │                    └─ phrase  ├─ 还有要问的 → ask → wait（暂停，等患者回答）┐
          └───────────────────────────────┼─────────────────────────────────────────────┘
                                          └─ 问完了 → retrieve → draft → check ─┬─ 通过 → finalize
                                                                     ▲          │
                                                                     └─ 不通过（最多重写2次）
```

- `screen`：每轮先用正则规则检查患者说过的话，命中Ⅰ、Ⅱ级直接进急诊，不调用模型。
- `triage` 和 `phrase`（改写追问措辞）并行。`AGENT_PHRASING=template` 时不改写，直接用模板问法，每轮少一次调用。

- `retrieve`：问完以后检索诊疗指南（见下面「指南检索」）。

### 每轮延迟和成本（#10）

`npx tsx scripts/bench-latency.ts` 跑 6 个演示病例和 2 个急诊场景。没有 Bedrock 密钥时，每次模型调用按假设的首字延迟和输出速度真实等待，tokens 按字符估算，按 Haiku 4.5 / Sonnet 4.6 标价计费。调用次数是准确的，秒数和美元是估算。

| | 追问轮平均耗时 | 追问轮调用 | 追问轮成本 | 每次问诊调用 | 每次问诊成本 | 开场即急诊 |
|---|---|---|---|---|---|---|
| 优化前（串行） | 2.92s | 3 | $0.00337 | 11.8 | $0.0190 | 2 次调用 |
| 并行改写（默认） | 2.05s（-30%） | 3 | $0.00337 | 11.3 | $0.0184 | 0 次调用 |
| 模板问法 | 1.93s（-34%） | 2 | $0.00240（-29%） | 8.5 | $0.0158（-17%） | 0 次调用 |

明细在 `docs/agent/eval/latency-summary-simulated-*.md`。

- 待运行：需要密钥。真实 Bedrock 的数字用 `npx tsx scripts/bench-latency.ts --bedrock` 测。要决定是否去掉改写，用 `npx tsx scripts/eval-backend.ts --phrasing template` 和默认的 `--phrasing model` 各跑一次，比较完整性和准确性。
- 提示缓存暂不开启：单次调用的输入最多约 1.1K tokens（估算），而 Haiku 4.5 至少 4096 tokens 才能缓存，Sonnet 4.6 至少 1024 tokens，并且记录表每轮都在变，固定的前缀只有几百 tokens。快档换成 Haiku 5.5（最低 512 tokens）后再评估。

### 指南检索（#12）

病历里给医生的「可能的原因」和「建议检查」，每一条都要标注诊疗指南出处：

- `src/guidelines.ts` 是一个小型指南语料库：18 段，每段是对一份公开指南（中华医学会各分会、NICE 等）某条推荐的要点转述，并写明指南名称、发布机构和年份。**这是演示语料，不是指南原文**，使用前要核对原文和最新版本。
- 问诊结束后，`retrieve` 节点用主诉和已回答的要点检索（按字的二元组做 BM25，在进程内完成，不调用模型），取最相关的 4 段交给写病历的模型。
- 模型必须在每条建议的 `sources` 里写出依据的片段编号。`check` 节点逐条检查：没有出处，或引用了不在检索结果里的片段，都算问题，要求重写；自查模型还会检查片段是否真的支持这条建议。
- 病历里每条建议后面会显示「【依据：《指南名称》，机构，年份】」。

评测（`scripts/eval-backend.ts`）新增了几项：检索命中率（对照 `evals/guidelines/relevance.json` 中每个病例的相关片段）、引用覆盖率（有出处的建议占比）和**引用准确率**（引用的片段确实支持这条建议的占比，由裁判模型判断）。离线 mock 的结果在 `docs/agent/eval/backend-summary-mock-guidelines-2026-10-18.md`：检索命中 100%，引用覆盖率 100%，引用准确率 91.7%。离线时这些建议直接取自检索到的片段，准确率用字面重合粗略判断，只用来验证评测流程。用真实模型的引用准确率待运行：需要密钥。

药物相互作用检查和 ICD 编码这两个子任务还没有做。

## 二、本地一键运行

需要先安装Node.js 20或以上版本。在项目根目录执行：

```bash
npm install
npm run demo
```

程序会询问Bedrock的访问密钥：输入后使用AWS Bedrock上的真实模型；直接按回车则使用离线替身模型。输入的密钥只保存在内存中。启动后浏览器会自动打开 http://localhost:8787 的问诊页面，左侧以患者身份对话，右侧实时显示危险分级和问诊记录表。每次启动都会生成新的接口密钥，服务只接受本机访问。按Ctrl+C停止。

也可以先设置 `BEDROCK_ACCESS_KEY_ID` 和 `BEDROCK_SECRET_ACCESS_KEY` 环境变量，程序就不再询问。

## 三、离线运行命令行（不需要AWS账号）

离线模式使用一个按关键词工作的替身模型，用来演示流程、记忆和接口。替身的判断很粗糙，不代表真实模型的效果。

```bash
npm install

# 模拟患者按病例自动回答（可选病例：resp-001、gastro-001、cardio-001、neuro-001、ortho-001、endo-001）
npm run backend:cli -- --case cardio-001

# 自己扮演患者
npm run backend:cli
```

对话中可以输入以下命令：

- `/record`：查看当前的问诊记录表；
- `/quit`：退出。进度已保存，之后用 `npm run backend:cli -- --resume <问诊编号>` 继续。

## 四、接入AWS Bedrock

默认配置与公司autoclaw项目使用的Bedrock账号一致：区域为us-east-2，快档模型为Claude Haiku 4.5，慢档模型为Claude Sonnet 4.6。只需提供该账号的访问密钥：

```bash
export AGENT_LLM=bedrock
export BEDROCK_ACCESS_KEY_ID=<访问密钥ID>
export BEDROCK_SECRET_ACCESS_KEY=<访问密钥>
npm run backend:cli -- --case cardio-001
```

密钥使用单独的变量名，避免误用运行环境中已有的其他AWS凭证。如需更换区域或模型，可设置 `BEDROCK_REGION`、`BEDROCK_FAST_MODEL_ID`、`BEDROCK_SMART_MODEL_ID`。

说明：Claude Opus 5.5、Sonnet 5.5等新模型不支持强制指定工具，也不接受自定义temperature。因此程序以“自动选择”方式提供工具，不发送temperature，并在程序中校验模型返回的结果。该写法已用本地模拟的Bedrock接口测试过，尚未连接真实的AWS账号测试。

## 五、启动HTTP服务

```bash
API_KEYS=demo-key-123 npm run backend:server
```

接口示例：

```bash
# 开始问诊
curl -X POST localhost:8787/v1/consultations \
  -H 'authorization: Bearer demo-key-123' -H 'content-type: application/json' \
  -d '{"complaint":"我胸闷两周了"}'

# 回答问题
curl -X POST localhost:8787/v1/consultations/<问诊编号>/answers \
  -H 'authorization: Bearer demo-key-123' -H 'content-type: application/json' \
  -d '{"text":"上楼的时候更明显"}'

# 查看状态
curl localhost:8787/v1/consultations/<问诊编号> -H 'authorization: Bearer demo-key-123'
```

### 模型调用失败与重试

Bedrock 重试几次后仍然失败（限流、超时、连续返回不合格式的结果）时：

- 当次请求返回 **502**，响应体是 `{"error": "...", "retryable": true, "id": "<问诊编号>"}`。开始问诊的第一次调用就失败时，也会返回问诊编号，方便重试。
- 进度已经保存。之后查看状态，`status` 是 `"failed"`，`error` 字段说明失败在哪一步。
- 调用下面的接口，从失败的那一步接着跑。用的是同一个问诊编号，前面的步骤不会重跑：

```bash
curl -X POST localhost:8787/v1/consultations/<问诊编号>/retry -H 'authorization: Bearer demo-key-123'
```

- 失败状态下调用 `/answers` 会返回 409，提示改用 `/retry`；没有失败时调用 `/retry` 也返回 409。
- 同一个问诊同时只处理一个 `/answers` 或 `/retry` 请求：前一个还没处理完时，后到的请求返回 409，图不会被执行两次。
- 其他程序内部错误仍然返回 500。

演示页面会显示错误信息和「Retry」按钮。命令行里输入 `/retry` 重试。

两种情况不算失败，问诊照常完成：

- 病历**改写**失败：保留上一版草稿。
- **自查**失败：病历照常生成，并标注「自动自查未能完成，请医生人工复核」。

命令行也可以连接HTTP服务：

```bash
npm run backend:cli -- --server http://localhost:8787 --key demo-key-123 --case resp-001
```

## 五（附）、节点级追踪（Langfuse）

每次问诊的每个图节点（setup、understand、triage、ask、wait、draft、check、finalize/emergency）都会记成 Langfuse 的一个 span：

- 每次调用（开始、每轮回答、重试）是一条 trace。
- 同一次问诊的所有 trace 归在同一个 session 下，session id 就是问诊编号（LangGraph 的 `thread_id`），在 Langfuse 里按 session 就能看到整次问诊每一步的输入、输出和耗时。
- Next.js 的 `/api/agent` 也接了同样的追踪：每个请求生成一个 run id，当作 session。

**默认关闭**。只有 `LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_BASE_URL` 三个都设置了才开启，代码在 `shared/tracing/langfuse.ts`。

**隐私**：患者说的话属于敏感数据，默认推荐**自托管** Langfuse。所有 span 在发出前都会经过脱敏：

| `LANGFUSE_BASE_URL` | 脱敏方式 |
|---|---|
| localhost、内网地址（10.x / 172.16–31.x / 192.168.x）、`*.local`、`*.internal`，或设置了 `LANGFUSE_SELF_HOSTED=true` | 只隐藏手机号和身份证号，其余文本保留，方便排查 |
| 其他地址（比如 Langfuse Cloud） | **全部文本**都替换成「[已隐藏 N 字]」，只保留图结构、耗时和 token 数 |

本地启动 Langfuse，用官方的 docker compose（包含 Postgres、ClickHouse、Redis、MinIO）：

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d
# 浏览器打开 http://localhost:3000，注册、建项目，在 Settings → API Keys 生成密钥
```

然后：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... LANGFUSE_BASE_URL=http://localhost:3000 \
  API_KEYS=demo-key-123 npm run backend:server
```

<!-- TODO(#9): 接入真实 Langfuse 后，把一次完整问诊的 trace 截图放在 docs/agent/img/langfuse-trace.png，并在这里引用。 -->
> 截图待补：需要一个运行中的 Langfuse 实例（本次开发环境没有）。

依赖版本：`@langfuse/langchain`、`@langfuse/otel`、`@langfuse/tracing`、`@langfuse/core` 固定在 5.11.1，OpenTelemetry 固定在 2.11.0。6.0.0 刚发布几天，暂不升级。

## 六、安全设置

1. 除健康检查外，所有接口都要求 `Authorization: Bearer <接口密钥>`。密钥通过 `API_KEYS` 环境变量配置，可以配置多个，用英文逗号分隔。程序只保存密钥的哈希值，并用恒定时间比较，避免时序攻击。
2. 每次问诊只能由创建它的密钥查看和回答，其他密钥访问一律返回404。
3. 每个密钥每分钟的请求数有上限（`RATE_LIMIT_PER_MINUTE`，默认30）；每天新建的问诊数也有上限（`DAILY_CONSULTATION_LIMIT`，默认200），用于控制费用。
4. 请求体不超过8KB，单次输入不超过500字，只接受JSON格式。
5. 日志只记录请求路径、状态码和耗时，不记录患者说的内容。

## 七、配置项

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `AGENT_LLM` | `mock` 或 `bedrock` | `mock` |
| `BEDROCK_ACCESS_KEY_ID` / `BEDROCK_SECRET_ACCESS_KEY` | Bedrock账号的访问密钥 | 无，接入Bedrock时必填 |
| `BEDROCK_REGION` | Bedrock所在区域 | `us-east-2` |
| `BEDROCK_FAST_MODEL_ID` | 快档模型ID | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `BEDROCK_SMART_MODEL_ID` | 慢档模型ID | `us.anthropic.claude-sonnet-4-6` |
| `AGENT_PHRASING` | `model`：追问措辞由快档模型改写（与分级并行）；`template`：直接用模板问法 | `model` |
| `DB_PATH` | 问诊状态的保存位置 | `backend/data/consultations.sqlite` |
| `API_KEYS` | 接口密钥，逗号分隔 | 无，启动HTTP服务时必填 |
| `PORT` | HTTP端口 | `8787` |
| `RATE_LIMIT_PER_MINUTE` | 每个密钥每分钟请求上限 | `30` |
| `DAILY_CONSULTATION_LIMIT` | 每个密钥每天新建问诊上限 | `200` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | Langfuse 追踪，三个都设置才开启 | 无（关闭） |
| `LANGFUSE_SELF_HOSTED` | 设为 `true` 表示这个地址是自托管的，不做全文隐藏 | 无 |

## 八、测试

```bash
npm run backend:test
```

测试全部离线运行，覆盖以下内容：规划器的选题顺序、去重和轮数上限；记录表只接受能对上患者原话的内容；危险分级规则与否定词；完整问诊不重复提问；危险情况立即结束；重启进程后可接着上次的进度继续；自查不通过时重写；接口的密钥校验、访问隔离、输入检查、限流和每日上限；Bedrock请求的格式，用本地模拟的Bedrock接口验证；模型调用失败后显示为失败、返回502、可以重试（`backend/tests/failed-state.test.ts`）；以及开启追踪时每个节点都有 span、归到问诊编号对应的 session、手机号被隐藏（`backend/tests/tracing.test.ts`，用内存导出器代替 Langfuse 服务）。

## 九、已知限制

1. 尚未连接真实的AWS Bedrock测试。
2. 离线替身模型的判断很粗糙，只用于演示流程。
3. 演示使用SQLite保存状态，正式部署时改为PostgreSQL，LangGraph提供同样接口的PostgresSaver。
4. 限流计数和问诊锁默认保存在内存中，部署多个实例时需要改用Redis。
5. 规划器的停止条件做了简化：必填项和鉴别要点都有结果、或达到轮数上限即停止，暂未判断“可能诊断是否连续两轮不变”。

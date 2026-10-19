# 问诊Agent后端演示

本目录是问诊Agent的后端，也是仓库里唯一的一套问诊Agent实现（#13）：Next.js 的 `/agent` 页面通过 `/api/agent` 转发到这里（设置 `BACKEND_URL` 和 `BACKEND_API_KEY`）。使用LangGraph编排问诊流程，模型通过AWS Bedrock调用。可以命令行运行，也可以作为HTTP服务启动。

## 一、与设计文档的对应关系

设计文档在 [`docs/agent/DESIGN.md`](../docs/agent/DESIGN.md)，代码注释里的「DESIGN.md §x」都指向它。

| 设计文档 | 实现位置 |
|---|---|
| §3.3 危险分级（四级） | `../shared/safety/red-flags.ts`（唯一的规则表）、`src/triage.ts`：规则只能把等级调得更紧急，不能调低 |
| §6 问诊流程 | `src/graph.ts` |
| §7.1 问诊模板 | `src/templates.ts`：通用要点加胸痛、腹痛、头痛、咳嗽发热四类模板 |
| §7.2–§7.4 问诊记录表、选题规则、停止条件 | `src/record.ts`、`src/planner.ts` |
| §8 会话记忆与防重复追问 | `src/graph.ts` 中的 `wait` 节点暂停问诊，状态按问诊编号保存在SQLite（单机）或PostgreSQL（部署）中；`src/planner.ts` 的三层去重 |
| §9 接口与安全 | `src/server.ts`、`src/security.ts`、`src/lock.ts` |
| §12 成本控制 | 追问轮数和自查次数有上限；`src/llm.ts` 按步骤选用快、慢两档模型；每个接口密钥有每日问诊上限 |

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
- 默认直接用模板问法（`AGENT_PHRASING=template`）。设为 `model` 时由快档模型改写追问措辞，`phrase` 和 `triage` 并行。真实 Bedrock 上两种问法的病历质量相同，模板问法每轮少一次调用。

- `retrieve`：问完以后检索诊疗指南（见下面「指南检索」）。

### 每轮延迟和成本（#10）

`npx tsx scripts/bench-latency.ts --bedrock` 在真实 Bedrock 上跑 6 个演示病例和 2 个急诊场景（不加 `--bedrock` 时用模拟计时）：

| | 追问轮平均耗时 | 追问轮调用 | 追问轮成本 | 开场即急诊 |
|---|---|---|---|---|
| 优化前（串行） | 4.74s | 3 | $0.0064 | 2 次调用 |
| 并行改写 | 3.54s（-25%） | 3 | $0.0064 | 0 次调用 |
| 模板问法（默认） | 3.51s（-26%） | 2 | $0.0049（-24%） | 0 次调用 |

一次完整问诊约 $0.15、60 秒左右，其中写病历和自查占 35～40 秒。完整的真实评测见 `docs/agent/EVAL.md` 的「真实 Bedrock 评测」。

- 提示缓存暂不开启：快档单次调用的输入最多约 1.7K tokens，低于 Haiku 4.5 的 4096 门槛；慢档的输入有 3～4K tokens，但其中固定的前缀（系统提示和工具定义）不到 1024 tokens，达不到 Sonnet 4.6 的门槛。快档换成 Haiku 5.5（最低 512 tokens）后再评估。

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

密钥使用单独的变量名，避免误用运行环境中已有的其他AWS凭证。不设置这两个变量时，程序使用AWS SDK的默认凭证链：在ECS上就是任务的IAM角色，不需要任何访问密钥。如需更换区域或模型，可设置 `BEDROCK_REGION`、`BEDROCK_FAST_MODEL_ID`、`BEDROCK_SMART_MODEL_ID`。

说明：Claude Opus 5.5、Sonnet 5.5等新模型不支持强制指定工具，也不接受自定义temperature。因此程序以“自动选择”方式提供工具，不发送temperature，并在程序中校验模型返回的结果。该写法有本地模拟Bedrock接口的测试。

### 真实Bedrock的测试情况

- PR #2：在本地对真实的Bedrock模型（us-east-2，Haiku 4.5 + Sonnet 4.6）回放一段真实的患者对话，完整跑了10次，10次都生成了病历。
- 2026-10-19：在真实Bedrock上跑了完整评测（6个病例 × 3次 × 两种问法，三轮），以及危险信号分级和延迟对比，结果见 `docs/agent/EVAL.md` 的「真实 Bedrock 评测」。

### 默认模型

默认仍是快档 Claude Haiku 4.5、慢档 Claude Sonnet 4.6，这是有意保留的：

- 只有这两个模型在真实Bedrock上跑过（上面的10次）。换模型前需要用 `scripts/eval-backend.ts` 和 `scripts/eval-red-flags.ts --model` 在真实Bedrock上对比，这个环境没有密钥。
- 新一代更便宜（标价每百万tokens：Haiku 5.5 输入 $0.1 / 输出 $0.5，Haiku 4.5 为 $1 / $5；Sonnet 5.5 为 $2 / $10，Sonnet 4.6 为 $3 / $15），Haiku 5.5 的提示缓存门槛也低（512 tokens，Haiku 4.5 要 4096），但行为有变化：Haiku 5.5 默认开启思考（每次调用可能更慢），Sonnet 5.5 不接受强制指定工具。程序已经按「自动选择工具、不发temperature」写好，换模型只需设置 `BEDROCK_FAST_MODEL_ID` / `BEDROCK_SMART_MODEL_ID`，但效果和延迟要先测。
- 结论：等真实Bedrock评测跑完再决定是否升级；评测命令见上面的「每轮延迟和成本」。Bedrock的计费以AWS价格页为准。

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
- 同一个问诊同时只处理一个 `/answers` 或 `/retry` 请求：前一个还没处理完时，后到的请求返回 409，图不会被执行两次。这时查看状态，`status` 是 `"running"`。
- 客户端在请求处理完之前断开，服务端会中止这次运行，正在进行的模型调用也会取消，不再继续花钱。问诊保存为 `"failed"`，之后用 `/retry` 从中断的那一步继续（#7）。
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

## 五（附二）、部署（#11）

单机运行用SQLite和内存里的锁、限流。部署多个实例时：

- 设置 `DATABASE_URL`（或 `PGHOST` 等 `PG*` 变量），问诊状态改存 PostgreSQL（LangGraph 的 `PostgresSaver`，第一次启动时自动建表）。实例本身不保存状态，可以横向扩展。
- 设置 `REDIS_URL`，问诊锁和限流计数改存 Redis，所有实例共用。
- `GET /readyz` 检查数据库和 Redis 是否可用，供负载均衡做健康检查；`/healthz` 只表示进程还活着。
- 收到 SIGTERM 时，`/readyz` 先变成 503，新连接不再接收，进行中的请求处理完再退出（最多 `SHUTDOWN_TIMEOUT_MS`）。

镜像：`docker build -f backend/Dockerfile -t consult-backend .`（在仓库根目录执行）。本地用 `docker compose -f backend/docker-compose.yml up --build` 连同 Postgres 和 Redis 一起启动。部署到 AWS（ECS Fargate + RDS + ElastiCache，私有子网经 VPC 终端节点访问 Bedrock，密钥放在 Secrets Manager）的模板和步骤见 `deploy/aws/README.md`。实际部署会产生费用，待运行：需要 AWS 账号并确认费用。

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
| `BEDROCK_ACCESS_KEY_ID` / `BEDROCK_SECRET_ACCESS_KEY` | Bedrock账号的访问密钥 | 无，不设置时用AWS默认凭证链（IAM角色） |
| `BEDROCK_REGION` | Bedrock所在区域 | `us-east-2` |
| `BEDROCK_FAST_MODEL_ID` | 快档模型ID | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `BEDROCK_SMART_MODEL_ID` | 慢档模型ID | `us.anthropic.claude-sonnet-4-6` |
| `AGENT_PHRASING` | `template`：直接用模板问法；`model`：追问措辞由快档模型改写（与分级并行） | `template` |
| `DB_PATH` | 问诊状态的保存位置（SQLite） | `backend/data/consultations.sqlite` |
| `DATABASE_URL` 或 `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGSSLMODE` | 设置后问诊状态存 PostgreSQL，`DB_PATH` 不再使用 | 无（用 SQLite） |
| `REDIS_URL` | 设置后问诊锁和限流存 Redis（`rediss://` 表示 TLS） | 无（存内存） |
| `LOCK_TTL_MS` | 持锁的实例意外退出时，锁多久后自动失效 | `300000` |
| `SHUTDOWN_TIMEOUT_MS` | 优雅停机时等待进行中请求的最长时间 | `25000` |
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

PostgreSQL 和 Redis 的集成测试不在上面的测试里，需要两个服务都启动后单独运行：`DATABASE_URL=... REDIS_URL=... npm run test:integration`（见 `deploy/aws/README.md`）。

测试全部离线运行，覆盖以下内容：规划器的选题顺序、去重和轮数上限；记录表只接受能对上患者原话的内容；危险分级规则与否定词；完整问诊不重复提问；危险情况立即结束；重启进程后可接着上次的进度继续；自查不通过时重写；接口的密钥校验、访问隔离、输入检查、限流和每日上限；Bedrock请求的格式，用本地模拟的Bedrock接口验证；模型调用失败后显示为失败、返回502、可以重试（`backend/tests/failed-state.test.ts`）；以及开启追踪时每个节点都有 span、归到问诊编号对应的 session、手机号被隐藏（`backend/tests/tracing.test.ts`，用内存导出器代替 Langfuse 服务）。

## 九、已知限制

1. 真实评测的样本还小：6个病例，每个3次，裁判也是模型。
2. 离线替身模型的判断很粗糙，只用于演示流程。
3. 不设置 `DATABASE_URL` 和 `REDIS_URL` 时，状态存在SQLite里，限流计数和问诊锁存在内存里，只适合单个实例。
4. 规划器的停止条件做了简化：必填项和鉴别要点都有结果、或达到轮数上限即停止，暂未判断“可能诊断是否连续两轮不变”。

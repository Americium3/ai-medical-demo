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
setup → understand → triage ─┬─ Ⅰ级或Ⅱ级 → emergency（提示急诊，结束）
            ▲                ├─ 还有要问的 → ask → wait（暂停，等患者回答）┐
            └────────────────┼─────────────────────────────────────────────┘
                             └─ 问完了 → draft → check ─┬─ 通过 → finalize
                                             ▲          │
                                             └─ 不通过（最多重写2次）
```

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
- 其他程序内部错误仍然返回 500。

演示页面会显示错误信息和「Retry」按钮。命令行里输入 `/retry` 重试。

两种情况不算失败，问诊照常完成：

- 病历**改写**失败：保留上一版草稿。
- **自查**失败：病历照常生成，并标注「自动自查未能完成，请医生人工复核」。

命令行也可以连接HTTP服务：

```bash
npm run backend:cli -- --server http://localhost:8787 --key demo-key-123 --case resp-001
```

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
| `DB_PATH` | 问诊状态的保存位置 | `backend/data/consultations.sqlite` |
| `API_KEYS` | 接口密钥，逗号分隔 | 无，启动HTTP服务时必填 |
| `PORT` | HTTP端口 | `8787` |
| `RATE_LIMIT_PER_MINUTE` | 每个密钥每分钟请求上限 | `30` |
| `DAILY_CONSULTATION_LIMIT` | 每个密钥每天新建问诊上限 | `200` |

## 八、测试

```bash
npm run backend:test
```

测试全部离线运行，覆盖以下内容：规划器的选题顺序、去重和轮数上限；记录表只接受能对上患者原话的内容；危险分级规则与否定词；完整问诊不重复提问；危险情况立即结束；重启进程后可接着上次的进度继续；自查不通过时重写；接口的密钥校验、访问隔离、输入检查、限流和每日上限；Bedrock请求的格式，用本地模拟的Bedrock接口验证；以及模型调用失败后显示为失败、返回502、可以重试（`backend/tests/failed-state.test.ts`）。

## 九、已知限制

1. 尚未连接真实的AWS Bedrock测试。
2. 离线替身模型的判断很粗糙，只用于演示流程。
3. 演示使用SQLite保存状态，正式部署时改为PostgreSQL，LangGraph提供同样接口的PostgresSaver。
4. 限流计数保存在内存中，部署多个实例时需要改用Redis。
5. 规划器的停止条件做了简化：必填项和鉴别要点都有结果、或达到轮数上限即停止，暂未判断“可能诊断是否连续两轮不变”。

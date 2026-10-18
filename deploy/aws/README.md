# 部署到 AWS（ECS Fargate + RDS + ElastiCache）

`template.yaml` 是一份 CloudFormation 模板，一次建好下面这些资源：

```
互联网 → ALB（公有子网）→ ECS Fargate 任务 ×2（私有子网，没有公网出口）
                              ├─ RDS PostgreSQL 17：LangGraph 的问诊状态（PostgresSaver）
                              ├─ ElastiCache Redis（TLS）：问诊锁、限流计数
                              └─ VPC 终端节点：Bedrock Runtime、Secrets Manager、ECR、CloudWatch Logs、S3
```

- **无状态、可横向扩展**：问诊状态在 Postgres 里，锁和限流在 Redis 里，任意一个任务都能接着处理任意一个问诊。
- **IAM 角色，不用访问密钥**：任务角色只允许调用配置的两个 Claude 模型（`bedrock:InvokeModel`）。程序没有设置 `BEDROCK_ACCESS_KEY_ID` 时，走 AWS SDK 的默认凭证链，在 ECS 上就是任务角色。
- **私有访问 Bedrock**：私有子网没有 NAT，也没有到互联网的路由。调用 Bedrock、读取密钥、拉镜像、写日志，都走 VPC 终端节点。
- **密钥放在 Secrets Manager**：接口密钥存成一个 secret；数据库密码由 RDS 自动生成并托管（`ManageMasterUserPassword`）。两者都在任务启动时注入环境变量，不写进镜像，也不写进模板参数的明文。
- **就绪检查和优雅停机**：ALB 用 `/readyz` 做健康检查（同时检查 Postgres 和 Redis）。ECS 停任务时先发 SIGTERM，程序把 `/readyz` 变成 503，等进行中的请求处理完再退出（最多 25 秒）。
- **公开演示的费用控制**：默认 `AgentLlm=mock`，用离线替身模型，不产生 Bedrock 费用；每个密钥每分钟 10 次请求、每天 50 次问诊。

## 部署步骤

> 待运行：需要 AWS 账号和凭证，并且会产生费用（见下面的估算），执行前需要确认。

```bash
REGION=us-east-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/consult-backend

# 1. 构建并推送镜像（在仓库根目录执行）
aws ecr create-repository --repository-name consult-backend --region $REGION
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin ${REPO%/*}
docker build --platform linux/amd64 -f backend/Dockerfile -t $REPO:v1 .
docker push $REPO:v1

# 2. 创建栈（约 15 分钟，RDS 最慢）
aws cloudformation deploy --region $REGION --stack-name consult-demo \
  --template-file deploy/aws/template.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageUri=$REPO:v1 ApiKeys=$(openssl rand -hex 16) AgentLlm=mock

# 3. 演示地址
aws cloudformation describe-stacks --region $REGION --stack-name consult-demo \
  --query "Stacks[0].Outputs[?OutputKey=='DemoUrl'].OutputValue" --output text

# 换成真实模型：先在 Bedrock 控制台为账号开通这两个模型，再
aws cloudformation deploy ... --parameter-overrides AgentLlm=bedrock

# 用完删除（RDS 会先留一个快照）
aws cloudformation delete-stack --region $REGION --stack-name consult-demo
```

`--platform linux/amd64` 与模板里的 `CpuArchitecture: X86_64` 对应。

## 每月费用估算（us-east-2，按需价格，不含 Bedrock 调用）

| 资源 | 规格 | 约每月 |
|---|---|---|
| ECS Fargate | 2 个任务 × 0.5 vCPU / 1 GB | $36 |
| ALB | 1 个，流量很小 | $20 |
| RDS PostgreSQL | db.t4g.micro，20 GB gp3 | $14 |
| ElastiCache Redis | cache.t4g.micro × 1 | $12 |
| VPC 接口终端节点 | 5 个 × 2 个可用区 | $73 |
| CloudWatch Logs、Secrets Manager | | $2 |
| **合计** | | **约 $157** |

省钱的办法：`DesiredCount=1`，大约省 $18；接口终端节点只放一个可用区，大约省 $36。真实模型每次问诊的费用见 `backend/README.md` 的延迟和成本表（估算约 $0.02 一次）。价格以 AWS 官网为准。

## 本地验证

`backend/docker-compose.yml` 用同一个镜像，加上 Postgres 和 Redis，在本机模拟这套部署：

```bash
docker compose -f backend/docker-compose.yml up --build
# 打开 http://localhost:8787，接口密钥 demo-key-123

# 对真实的 Postgres 和 Redis 跑集成测试
DATABASE_URL=postgres://app:app@localhost:5432/consult REDIS_URL=redis://localhost:6379 npm run test:integration
```

模板用 `cfn-lint` 检查通过。

## 中国大陆

医疗数据需要留在境内，而 AWS 中国区没有 Bedrock。部署到中国区时，需要用国内大模型实现 `backend/src/llm.ts` 的 `LLM` 接口（接口本身支持替换），并去掉模板里的 Bedrock 终端节点和权限。

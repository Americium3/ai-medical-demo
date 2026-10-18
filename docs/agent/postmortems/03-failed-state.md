# 复盘：[backend] 问诊失败后显示「已完成」且无法重试（#3）

## 怎么发现的

读 `service.view()` 时发现：状态只分「在等回答」和「不在等」两种，「不在等」又只按 `s.status === "emergency"` 区分急诊和完成。于是写了一个包装器，让模拟模型在第一次写病历（`note`）时抛出 `LLMError`，模拟 Bedrock 重试后仍然失败，结果完全复现了 issue 描述的现象：

- 回答问题的那次请求返回 **500 Internal error**，客户端分不清是程序出错还是模型暂时不可用；
- 之后 `GET` 这次问诊，`status` 是 **`completed`**，`output` 是空字符串；
- 再回答返回 409「not waiting for an answer」，没有任何接口能让它继续。

如果第一次模型调用（开始问诊时的信息提取）就失败，情况更糟：`POST /v1/consultations` 返回 500，响应里没有问诊编号，客户端连这次问诊的编号都拿不到。

## 为什么会发生

- LangGraph 的 checkpointer 其实已经把失败记下来了：失败的那一步还在待执行任务里，上面带着 `error`，状态停在失败之前。可 `view()` 只看 `interrupts`，没看 `error`，所以「没在等回答」被直接当成了「完成」。
- `server.ts` 只认识 `HttpError`、`NotFoundError`、`ConflictError` 三种错误，`LLMError` 被归到 500，异常也没带问诊编号。
- 没有重试入口。其实 LangGraph 本身就支持：对同一个 `thread_id` 再调一次 `stream(null)`，就会从出错的那一步接着跑。

图里已经处理过「改写失败」和「自查失败」（保留旧稿、标注人工复核），但**第一次写病历**和**其他步骤**失败时，没有对应的状态。测试只覆盖了成功路径，模拟模型从来不会失败。

## 怎么修的

1. **`service.view()`**：只要待执行任务上带着 `error`，就返回 `status: "failed"` 和 `error`，`output` 为空。`ConsultationView` 的状态类型加上 `"failed"`。
2. **`service.run()`**：把 `LLMError` 包成 `ModelFailureError(id, cause)`，让上层拿得到问诊编号。
3. **新增 `service.retry(id, owner)`**：只有失败状态才能调用，否则抛 `ConflictError`。它在同一个 `thread_id` 上调用 `stream(null)`，从失败的那一步继续，前面的步骤不会重跑。
4. **`server.ts`**：
   - 新增 `POST /v1/consultations/:id/retry`。
   - `ModelFailureError` 返回 **502** `{ error, retryable: true, id }`。
   - 其他程序内部错误仍返回 500。
5. **`answer()`**：失败状态下返回 409，提示改用 `/retry`。
6. **演示页面**：失败时显示错误信息和「Retry」按钮；收到 502 时从响应里取问诊编号。**命令行**：`/retry`，脚本患者最多自动重试 2 次。

计划里说要在 `render.ts` 处理失败状态。实际上 `render.ts` 只负责渲染已完成的病历和急诊提示，不按状态分支；失败状态没有输出，所以改的是读取 `status` 的地方，也就是演示页面和命令行。

「同一问诊并发回答」的竞争（#6）属于阶段二，这次不处理。

## 怎么防止再犯

- `backend/tests/failed-state.test.ts` 用一个故障注入包装器（`failing(llm, task, times)`），让指定的那一步失败。以后新增节点时，用这个包装器就能测它失败的路径。
- 状态完全由 checkpointer 里的任务状态推出来，不另外维护一个「失败」标记，所以不会和实际状态对不上。

## 加了哪些测试

`backend/tests/failed-state.test.ts`，5 个测试：

| 测试 | 修复前（1cc3eca） | 修复后 |
|---|---|---|
| 第一次写病历失败 → 显示 `failed`，重试后变成 `completed` | **失败**（显示 `completed`） | 通过 |
| HTTP：失败返回 502 retryable，GET 显示 failed，`/answers` 返回 409，retry 后完成 | **失败**（返回 500） | 通过 |
| 第一次模型调用就失败，仍可通过问诊编号重试（修复时补的） | 修复前接口不存在 | 通过 |
| 改写失败时保留上一版草稿 | 通过（已有行为，这次补上测试） | 通过 |
| 自查失败时完成病历，并标注人工复核 | 通过（已有行为，这次补上测试） | 通过 |

另外，用模拟模型和故障注入启动了真实的 HTTP 服务，用 curl 手动走了一遍：开始问诊 → 第 4 次回答返回 502（带问诊编号）→ GET 显示 `failed` → retry 返回 200 → GET 显示 `completed`。

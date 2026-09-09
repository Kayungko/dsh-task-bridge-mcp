---
name: dsh-task-bridge
description: 通过 dsh-task-bridge MCP 工具（dsh_task_spawn/send/progress/wait/list/models）驱动 DSH Desktop 任务会话时的使用纪律：拉模型循环、串行派发过策略闸、回执字段解读、错误码处置。凡调用任一 dsh_task_* 工具前必读。
---

# DSH task-bridge 使用纪律（Codex 侧）

本 skill 约束通过 `dsh-task-bridge` MCP server（工具前缀 `dsh_task_`）驱动 DSH Desktop
任务会话的行为。核心心智模型：**拉非推（pull, not push）**——你没有入站通道，
DSH 任务不会主动向你汇报；一切反馈靠你主动 `wait` + `progress` 拉取。

## 0. 心智模型

```
你（Codex）──dsh_task_spawn──> DSH 任务会话启动并自主运行
       <──dsh_task_wait────── 分段长轮询（≤50s/次）直到空闲
       <──dsh_task_progress── 拉 recent 尾部/todos/goal 读反馈
       ──dsh_task_send──────> 纠偏/补充（steer=立即生效，queue=下一轮）
```

`reportBack` 已被**结构性关闭**（spawn 工具无此参数）：新任务不会、也不能主动回报，
反馈一律拉取。这不是缺陷，是审计与治理的设计决定。

## 1. 工具速查

| 工具 | 用途 | 一次调用要点 |
|---|---|---|
| `dsh_task_models` | 查合法 provider/model id | 派发前不确定路线就先查；**绝不猜 id** |
| `dsh_task_spawn` | 创建任务会话 + 投递 kickoff | `prompt` 必须完整自包含（目标看不到你的上下文）；**串行派发**（见 §2） |
| `dsh_task_wait` | 等目标空闲（长轮询） | `timeoutMs` 默认 45000、上限 50000（自动钳制）；多目标可 `mode:"any"` |
| `dsh_task_progress` | 读进度快照 | 不打扰目标；`recent` 是尾部摘要（条数/字数受桥配置限制） |
| `dsh_task_send` | 纠偏/补充/交接 | 运行中目标用 `mode:"steer"`；空闲/追加用默认 queue |
| `dsh_task_list` | 列任务（重建上下文） | 换会话后先用它（可 `team` 过滤）找回指挥现场 |

## 2. 拉模型纪律（硬约束）

1. **spawn 后不轮询轰炸**：不要循环 `progress` 等待。`wait` 长轮询本身就是等待——
   目标空闲或 45s 超时才返回。`progress` 只在三种时机读：`wait` 返回 `settled:true` 后
   读结果；需要做决策（要不要 steer）前读上下文；怀疑目标卡死时核对 `seq` 是否推进。
2. **wait 分段等**：`settled:false` 是**正常心跳**而非错误——同一意图内继续 call 即可，
   直到 `settled:true` 或你决定放弃等待。`timeoutMs` 永远不要传超过 50000
   （wrapper 会钳制；Codex 工具超时 60s 是硬顶）。
3. **串行派发过策略闸**：一次只spawn 一个任务，等它的 kickoff 被消费（`wait` 空闲 +
   `progress` 确认开工）后再派下一个。滚动 60s 窗口内 spawn 超过 2 次会触发桥侧
   策略闸（见 §3）。
4. **冷 ≠ 无待办**：`wait` 对冷会话（无活动 agent）返回 `settled:true` 是「空闲」语义，
   不是「完成」语义——结果与待办要用 `progress` 确认。

## 3. 策略闸（confirmation-required）

桥侧对外部 spawn 有滚动窗口策略闸：**60s 内超过 2 次 spawn 且无有效凭证 →
429 `confirmation-required`**（语义对齐 DSH 侧 `confirmBatchThreshold` 批量确认门）。

处置：

- 收到 `confirmation-required`：**立即停止派发**，把意图与剩余任务清单报告给人类，
  等待指示。**绝不**用放慢节奏（59s 一次）绕闸——那是绕过治理，不是合规。
- 该闸存在的原因：外部驱动方用串行单发绕过批量确认的治理漏洞已被设计堵死
  （蓝图 §3.3.3）；你的串行派发权是受信任的低频特权。
- DSH GUI 会话里预批的 reusable 凭证**对你不可用**（凭证绑定 DSH 侧会话 id）。

## 4. 回执字段解读

### 4.1 dsh_task_spawn 回执

| 字段 | 解读与动作 |
|---|---|
| `sessionId` / `shortId` / `title` | 任务身份；后续所有工具用 `sessionId` |
| `workspace` `{id,title}\|null` | 任务归属工作区；null=未分组 |
| `placement` | 五级落位：`exact-match` ✓ / `caller-inherited` ✓ / `ancestor-normalized`（cwd 被归一到工作区根，看 `normalizedFrom`+`note`）/ `ungrouped-worktree`、`ungrouped`（**带 warning，须先补救**：确认 cwd 是否预期、考虑换 cwd 重派或让人类处置） |
| `model` + `modelSource` | 实际模型路线与来源：`explicit`=你指定的 / `plugin-default`=插件设置 / `host-default`=宿主默认。**不符预期立即停止**（拿 `sessionId` 找人类，或 send 纠正后重启任务） |
| `started` | kickoff 是否已投递 |
| `correlationId` | 可作为后续 `send` 的 `reference`，形成可追溯纠偏链 |
| `depth` | 递归深度（桥 spawn 恒为 1） |
| 失败分支的孤儿 `sessionId` | `model-select-failed` / `kickoff-rejected` 时会话**已创建但 kickoff 未消费**：用 `dsh_task_send` 补发开场消息可救活；或明确放弃（让人类处置孤儿会话） |

### 4.2 dsh_task_send 回执

| 字段 | 解读与动作 |
|---|---|
| `messageId` | 本条消息 id，可被后续 send 的 `reference` 引用 |
| `queueDepth` `{nextTurn,nextStep}` | 投递后队列深度（含本条）。**`nextTurn>=2` ≈ 该消息约 2 轮后才被读**——晚一步=白干一步：改用 `mode:"steer"`（若目标运行中）或先等一轮 |
| `placement` | `next-step`=steer 已在当前轮下一生效步骤生效 / `next-turn`=已排队 |
| `targetStatus` | `running` / `idle` |
| `note` | 冷目标投递警告（冷会话不在队列深度守卫覆盖内），如有须留意 |

### 4.3 dsh_task_wait 回执

| 字段 | 解读 |
|---|---|
| `settled` | `true`=目标空闲；`false`=本轮超时仍在运行（**正常心跳**，续 call） |
| `waitedMs` | 实际等待毫秒 |
| `targets[]` | 各目标状态（含 `agentState`） |

### 4.4 dsh_task_progress 回执

| 字段 | 解读 |
|---|---|
| `live` | true=活动会话 / false=冷会话（冷≠无待办） |
| `agentState` | 活动状态口径（live-idle / cold-idle 等） |
| `queue` | 排队消息深度（>0 说明有消息待消费） |
| `recent[]` | 最近消息尾部摘要（条数与每条字符数受桥配置限制，只作态势感知，不作全文依据） |
| `todos` | 任务清单完成度 |
| `goal` | 目标进度（如有） |
| `seq` | 序列号；两次读取 seq 不变 = 无新事件 |

## 5. 错误码处置表

所有 `isError:true` 的工具返回都是 `{ok:false, code, error, …}` 信封
（`error` 为人读文案，附加字段如 `retryAfterMs`、孤儿 `sessionId` 一并透传）。

### wrapper 层（本 MCP server 产生）

| code | 含义 | 处置 |
|---|---|---|
| `token-missing` | env 与 token 文件均无可用 token | 检查 `TASK_BRIDGE_TOKEN` / `TASK_BRIDGE_TOKEN_FILE` / `~/.dsh/task-bridge-token`；确认桥已启用。无法自行解决时报告人类 |
| `bridge-unreachable` | 连不上桥（DSH 未运行 / 桥未启用 / URL 错） | 报错文案含 base URL 与覆盖方法；确认 DSH Desktop 运行中 |
| `bridge-timeout` | 请求超时 | wait 调用会提示缩短 `timeoutMs`（上限 50000）；其他工具重试一次，仍超时报告人类 |
| `bridge-http-error` | 桥回了非信封 HTTP 错误（如 503 coordinator disabled） | 读文案中的状态码与 body 摘要；503=桥在但 coordinator 禁用，报告人类 |
| `bridge-invalid-response` | 响应不是 `{ok:true,…}` 信封 | 桥版本不匹配嫌疑；报告人类 |
| `invalid-params` | 工具入参校验失败（如缺 `prompt`/`sessionId`） | 按 error 文案补参数重试 |
| `internal-error` | wrapper 内部异常 | 附 `error` 中的堆栈摘要报告人类 |

### 桥层（桥端 code 透传）

| code | 含义 | 处置 |
|---|---|---|
| `unauthorized` / `forbidden` | token 无效（401/403） | token 过期/轮换嫌疑；报告人类（勿自行改 token） |
| `confirmation-required` | 策略闸：60s 窗口内 spawn 超限（429） | **立即停止派发**，报告人类，等待指示（见 §3） |
| `rate-limited` | send 限频（429，附 `retryAfterMs`） | 等 `retryAfterMs` 后重发；**不要**缩短间隔硬冲 |
| `queue-full` | 目标队列已满（429） | 等目标消费（`wait`）再发；持续满说明目标过载，考虑 steer 叫停 |
| `target-busy` | 目标忙（409） | `wait` 后重试或改 steer |
| `target-not-found` / `target-vanished` | 目标不存在/已消失（404） | 核对 `sessionId`；`target-vanished` 用 `dsh_task_list` 重建现场 |
| `model-select-failed` | spawn 模型校验失败（**含孤儿 sessionId**） | 先 `dsh_task_models` 查正确 id；补 send 开场救活或放弃 |
| `kickoff-rejected` | kickoff 被拒（**含孤儿 sessionId**） | 读 `error` 原因；补 send 开场救活或放弃 |
| `spawn-depth-exceeded` | 递归深度超限 | 桥 spawn 恒 depth 1，正常不触发；触发即桥语义变化，报告人类 |
| `bad-request` | 参数被桥拒绝（400） | 对照 error 文案修参数 |

## 6. 典型完整循环（伪调用）

```
# 0) 派发前
dsh_task_models {}
→ 选定 provider "p1" / model "m1"

# 1) 串行派发（过策略闸）
dsh_task_spawn {prompt:"<完整自包含指令>", title:"修复｜对账精度", team:"bridge-mvp", provider:"p1", model:"m1"}
→ 检查回执：placement 无 warning？modelSource 符合预期？记下 sessionId

# 2) 分段等待（不轮询）
dsh_task_wait {sessionIds:"<id>"}            → settled:false（心跳，续 call）
dsh_task_wait {sessionIds:"<id>"}            → settled:true

# 3) 读结果
dsh_task_progress {sessionId:"<id>"}         → recent/todos/goal 判断是否达标

# 4) 需要纠偏（运行中）
dsh_task_send {sessionId:"<id>", message:"停止当前方向，改为…", mode:"steer", reference:"<correlationId>"}
→ queueDepth.nextStep=0 即已生效；回 step 2 继续等

# 5) 多任务汇合
dsh_task_wait {sessionIds:["<id1>","<id2>"], mode:"all"}
```

---

依据：`research/task-bridge-reanchoring.md` §0.2/§3（端点与回执）、§4.3（拉模型纪律）；
wrapper 实现：`D:\git\DHS-Tool\bridge-mcp`（工具 description 与本文件同步维护）。

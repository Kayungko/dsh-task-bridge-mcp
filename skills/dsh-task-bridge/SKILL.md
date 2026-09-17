---
name: dsh-task-bridge
description: DSH 桥接 MCP 的接口兼容说明。需要核对 dsh_task_* 参数、投递语义、错误和回执时使用；通用任务路由与托管流程见 dsh-orchestration。
---

# 桥接接口参考

这是保留给既有 MCP 引用的协议入口。日常操作、监控与多事项托管从 [dsh-orchestration](../dsh-orchestration/SKILL.md) 进入，按需读取本页，不重复加载所有工作流说明。

## 能力与工具

桥 spawn 固定 reportBack=false，不向虚拟 caller 发出 DSH 原生回报。结果通过 progress/wait 或已配置文件信箱取得；信箱写入不等于唤醒 Codex。原生 DSH 会话间汇报机制保持独立。

| 工具 | 作用 | 关键边界 |
|---|---|---|
| dsh_task_capabilities | 查询运行版本、能力、限制 | 缺席或 false 不当作已部署生效 |
| dsh_task_models | 查询真实模型路线 | 不猜 provider/model；不指定时保留默认 |
| dsh_task_spawn | 新建 DSH 会话并投递开场 | 自包含任务书，显式 cwd，核对落位、模型、sessionId |
| dsh_task_send | 向已知会话投递消息 | MCP message 映射 HTTP text；需现有用户授权 |
| dsh_task_progress | 读取目标状态/反馈 | 支持 cursor 与 messageId 对账，覆盖缺口不能猜 |
| dsh_task_wait | 等当前轮空闲 | 默认 45000ms，封顶 50000ms；不是完成验收 |
| dsh_task_list | 查询当前可见任务 | team/filter 缩小范围；截断列表不能判唯一身份 |

CLI 的 monitor/workflow 不是额外 MCP 工具。有本地命令能力才能运行它们；桥没有公开 cancel/confirm/spawn_batch 端点，不冒充原生工具能力。

## 派发与投递

串行发出 spawn 请求并检查回执；独立任务可以并行执行，不必等待前一任务全部结束。默认策略闸限制滚动 60 秒内最多 10 次 spawn，实际值以 capabilities 为准。

cwd 缺省来自桥配置或宿主用户目录，不继承 Codex 当前目录。回执 ungrouped/worktree 警告需要核对实际目录与授权；保留已创建 sessionId，不能通过重复 spawn 修正分组。模型路线不符时先纠正路线，不能在错误模型上补发执行任务。

queue 用于后续背景或交接；steer 用于必须改变运行中目标下一步的纠偏。steer 在可用步骤边界生效，不能中断已开始的长工具调用，空闲/收尾期可能退回下一轮队列。

| 事实 | 证明什么 |
|---|---|
| delivered=true | 投递接口接受，不代表模型消费或完成 |
| placement=next-step/next-turn | 消息投递位置，不是已执行证明 |
| queueDepth | 查询时的排队深度；归零不能证明指令执行 |
| consumption=observed | 扫描到同 ID 用户消息，不证明业务执行成功 |
| settled=true / idle | 本次等待的空闲条件满足，不是验收通过 |
| receiptPersisted=false | 记账失败；派发/发送可能已成功，不能重派 |

correlationId、messageId 和 reference 用于追溯；externalRef 用于跨端分组，不是认证或幂等键。超时或回执不确定先 progress/list 对账，不盲目重发。

## 反馈读取

保存 feedback.nextCursor，后续原样传入；有游标时读取 feedback.messages，recent 为空。hasMore=true 表示还有后续页面。partial/unavailable 与 truncated 必须保留，不假装读到了全部历史。

messageId 可对账 queued/observed/unknown。unknown 不是未送达；不能据此重新发同一指令。已确认存在的冷会话可返回 cold-idle，不存在的目标应返回 not-found。

wait 的 settled=false 是正常超时心跳。等待要有总预算，避免模型反复读取无变化快照。长时间观测用本地 monitor；存在业务待办时用 workflow，不把无新通知当成可以丢弃待办。

## 错误处置

| code | 处置 |
|---|---|
| unauthorized | 核对凭据来源和回环连接，不显示或更改凭据 |
| forbidden-body / bad-request | 核对字段、类型、方法与大小 |
| policy-gated | 配额型按 retryAfterMs 等待；深度拒绝需核对范围，不能不断重试 |
| rate-limited | 等待并对账，不自动重发不确定消息 |
| queue-full | 等目标消费；不要连续灌入队列 |
| not-found | 重新查当前目标，不把旧 ID 当作仍有效 |
| upstream-error | 看 upstreamCode 与既有 sessionId，保留补救信息 |

model-select-failed 表示已创建但模型未正确安装，先通过原生控制面核对路线；kickoff-rejected 先确认原请求是否接收，再在授权内决定补发。两者都不能通过新建重复会话掩盖错误。

详细字段见 [接入契约](../../docs/codex-integration.md)。通知呈现依赖宿主实际能力，不约定手写控制标签作为静默协议。

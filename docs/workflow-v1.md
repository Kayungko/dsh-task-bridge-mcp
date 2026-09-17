# 通用工作流 v1（源码首版）

## 定位和边界

工作事项独立于会话。一个工作流可以包含文档、调研、代码、复审等不同 kind；kind/action/resource 是声明的标识，不是自动获得的工具权限。传输继续复用桥接口，旧 monitor、台账、信箱与现有自动化不自动迁移。

本版实现本地持久化控制面、确定性状态流转、正式 CLI、DSH 增量采集与消息派发适配器。它不包含自主规划模型、不自动创建 heartbeat、不接管正在运行的总控，也不实现远端多机器身份认证。观察数据不经字符串关键词自动变成授权或完成结论。

`controller/observers` 是本地路由和执行角色约束。拥有同一操作系统账户文件访问权的进程可以修改文件；CLI 的 `--owner` 不是认证凭据。`authorizationRef` 必须由上层代理在已有真实用户授权后登记，记录本身不能证明用户授权，更不能给来信扩大权限。本控制面不替代宿主沙箱，也不约束绕开 workflow 使用的任意文件/工具操作。

## 对象和标识

| 对象 | 标识、版本与职责 |
|---|---|
| 工作流 | 创建时生成 UUID；稳定 ID 不随 controller 更换，title 仅显示 |
| controller / observers | `platform + hostId + sessionId`；只有当前 controller 可执行工作变更，观察者只读并维护自己的通知进度 |
| binding | 稳定 binding.id 指向实际 DSH 会话，带 baseUrl/hostId/epoch/cursor；更换目标必须显式 rebind 并增加 epoch |
| policy | mode、允许的 actions/resources/bindings、授权引用、过期时间、并发/尝试/外部动作预算；每次改动递增 revision |
| item | 稳定 item.id、subjectVersion、revision、依赖、完成条件；不以会话 idle 代替完成 |
| run | 一次领取、租约到期和 claimId；冻结事项/授权/owner/binding 版本，过期执行者不能提交完成 |
| effect | 外部副作用的 operationId、请求指纹、发送状态与回执；不保存完整消息正文 |
| event / seen | 结构化事件和各观察者通知游标；标记 seen 不删除事件、不关闭 item |

claimId 是本地执行尝试的 fencing 标识，不是宿主认证密钥。baseUrl 必须是回环 HTTP(S) 根地址，无凭据、查询或片段。hostId 是显式连接标签，不冒充远端实例的密码学身份证明。

状态写入 `~/.dshq/workflow-<工作流ID摘要>.json`；事务复用 Store 写锁、原子替换和类型/引用检查，不写 Git 仓库。工作流文件与旧 monitor 文件独立。写失败保留旧状态，不推进事件游标。

## 状态和转换

| 状态 | 可推进条件 |
|---|---|
| ready | 依赖全部完成、当前 policy 允许、预算与并发可用后才能 claim |
| running | 持有有效 run/claimId；执行前及提交结论前再次检查版本和授权 |
| waiting | 等结果或修复；普通 progress 不重启工作，新 subjectVersion 的 result_ready/review_requested 才转新修订 ready |
| blocked | 输入/权限/来源/失败或对账阻塞；明确原因解决后由 controller resume |
| completed | controller 显式提交 accepted 与非空证据；handoff 类型还须有该修订的交接发送回执 |
| cancelled | 本地事项停止，不等于远端 DSH 任务已经停止 |

`finish outcome=needs_changes` 转 waiting，`failed` 转 blocked，不会假标 completed。新事件在 ready 状态到达时可更新到新 subjectVersion；running 时先记录，旧结果不能覆盖新请求，可用 wait 释放旧租约并转入已到达的新修订。旧 epoch/revision 事件保留但标 stale，不触发工作。

依赖先创建后引用，禁止缺失依赖和循环。如果上游修订会影响已经 running/completed 的下游，本版明确拒绝自动重写依赖图；使用新事项路径表达新版本。不会把旧下游结果当成适用于新上游的验收证据。

run 过期且没有已发送/不确定的副作用时，可以重新领取；旧 claimId 失效。过期前已经发送则阻塞，须先核对远端工作，不自动重复派发。文件写锁异常退出后遗留的问题仍使用明确错误与人工核验，本版不会擅自删除旧锁。

## 模式、授权与预算

- create 固定从 **observe** 开始：可查看，不允许 claim 或 send。
- **assist**：policy 范围之外还需要针对 item revision 的 approve 记录。
- **managed**：在当前 policy 授权范围内可以自动领取 ready 项；不是无限权限开关。
- policy 修改会使运行中的 claim 失效；ready/waiting 项仍保留，执行时按新 policy 检查。
- handoff 增加 ownerEpoch、使旧 claim 失效，并回到 observe，不能自动继承旧总控的执行权限。
- send 额外要求 policy.actions 含 `send`，resource 与 binding 也须匹配。resource 匹配是声明 ID 检查，真实路径/工具权限仍由宿主与执行代理负责。
- 每流最多 32 绑定、256 事项、2000 run/effect、10000 事件。容量耗尽明确拒绝，不按 FIFO 删除未完成事项；长期归档/压缩待后续扩展。

授权撤销可以拦截尚未开始的发送，不能撤回已经离开进程的请求。晚到的真实回执仍记账，但不能用旧授权完成工作。

## CLI

```text
dshq workflow create --input-file <JSON> [--owner <实际会话ID>]
dshq workflow <操作> <workflowId> [--input-file <JSON>] [--owner <实际会话ID>] --json
```

actor 默认取当前 CODEX_THREAD_ID、platform=codex、hostId=local。其他宿主显式传 `--actor-platform` / `--host-id`，不猜测身份。`--base` 不适用于 workflow，连接来自版本化 binding。

查询：`status / next / notices`。`next` 即使通知已读，仍返回未完成事项及 hold 原因；unresolvedEffects 非空时仍需对账。next 默认每页 20 项，--limit 最多 100；nextCursor 绑定工作流/调用方/状态视图，变化后须重新查询。通知默认每页 20 条，--limit 最多 50 条，mark-notices 后再取下一页；分页不会删除事项。

远端只读采集：`poll`，每绑定每次最多 4 页、每页最多 100 条消息，事件和 cursor 同事务落盘。每条源消息单独保存为 observation，不按会话覆盖；partial/unavailable 明确保留。不同 baseUrl/hostId 不能共享一个隐式游标。poll 的 `complete:false` 和各绑定错误必须处理，不能只看顶层 ok。

变更操作均使用不超过 256KB 的 JSON 输入文件，字段和类型由 `cli/lib/workflow-contract.mjs` 校验，未知字段拒绝。命令不会执行 JSON 内任意代码。

### create

```json
{
  "title": "文档评审工作流",
  "observers": [],
  "bindings": []
}
```

这是无 DSH 绑定的合法工作流，不需要 Git。需要绑定 DSH 时，每项提供：

```json
{
  "id": "worker",
  "platform": "dsh",
  "hostId": "local-dsh",
  "sessionId": "session-实际ID",
  "baseUrl": "http://127.0.0.1:43120",
  "epoch": 1,
  "cursor": null
}
```

示例 sessionId 必须替换为实际查询确认的 ID。当前适配器复用既有客户端的凭据来源，不把凭据放进配置。

### policy

输入为 `{expectedPolicyRevision, policy}`。policy 完整字段：

| 字段 | 约束 |
|---|---|
| revision | 当前版本 + 1 |
| mode | observe / assist / managed |
| actions / resources / bindings | 精确标识数组，不使用通配符自动扩权 |
| expiresAt | 毫秒时间戳；执行时必须尚未过期 |
| authorizationRef | 用户实际授权的记录引用；非 observe 必填，不以模型自述代替 |
| maxConcurrent | 1–16 |
| maxAttempts | 每事项跨修订累计最多 1–100 次 claim |
| maxEffects | 每流累计最多 1–2000 个外部动作 |

### add

```json
{
  "id": "review-document",
  "title": "核对研究报告",
  "kind": "document",
  "action": "review",
  "resource": "research-topic",
  "subjectVersion": "draft-v1",
  "bindingId": null,
  "dependsOn": [],
  "completion": "evidence"
}
```

kind/action 可使用业务适配器定义的标识。completion 为 evidence 或 handoff。证据数组使用 `{ref, version}`；ref 是可追溯来源位置，version 固定对应版本。核心检查证据记录结构，不自动证明外部文件真实性或业务质量；调用方须实际完成领域验证后提交 accepted。

### 其他输入

| 操作 | 必填字段 |
|---|---|
| approve | itemId, revision, authorizationRef, expiresAt |
| claim | itemId, revision, leaseMs（1000–3600000） |
| finish | runId, claimId, outcome（accepted/needs_changes/failed）, evidence, handoffEffectId（不需要时 null） |
| wait | runId, claimId, reason |
| resume / cancel | itemId, revision, reason |
| revise | itemId, revision, subjectVersion（必须变化）, evidence |
| event | sourceEventId, bindingId, bindingEpoch, itemId, itemRevision, kind, summary, evidence, subjectVersion |
| mark-notices | eventIds（本次实际返回 ID，最多 50 个） |
| rebind | bindingId, expectedEpoch, binding（新 epoch=旧+1、cursor=null）, authorizationRef |
| handoff | expectedOwnerEpoch, controller（platform/hostId/sessionId）, authorizationRef |
| send | runId, claimId, operationId, purpose（dispatch/handoff）, text, mode（queue/steer） |
| reconcile | operationId, outcome（delivered/not_delivered）, messageId（未送达时 null）, evidence |

event.kind 为 progress/result_ready/review_requested/input_required/failed。版本请求必须有非空 subjectVersion 与证据；普通进度可将 subjectVersion 置 null、evidence 置空。sourceEventId 在 binding epoch 与 item 内唯一；同 ID 同载荷重放不会重复推进，不同载荷拒绝。

## 外部发送的失败语义

`prepared → sending → delivered / unknown`。发送前写入 operationId 和请求指纹。客户端超时、响应损坏或落盘失败均保留不确定状态；即使换一个 operationId，也不能绕过同事项的不确定动作。

同一 operationId 同请求已 delivered 时复用回执；改变请求拒绝。reconcile 必须引用对账证据，operator 记录与真实 transport 回执标记不同。接收端当前没有按 operationId 去重，因此本版不承诺跨进程、跨服务器的 exactly-once，也不自动重放不确定副作用。

通知已读、桥投递成功、转录中已出现、工作完成、领域验收通过是不同事实，不能相互替代。

## 宿主与监控接入

Codex / DSH 代理均可通过本地 CLI 使用同一工作流文件和正式协议（必须遵守已授权角色）。后台本地采集可运行 poll；模型被唤醒后先读 next，再读必要的新 notices，领取后执行领域工作并提交结果。读取 notices=0 不能跳过 ready 项；waiting 时不重复审旧版本。

旧 monitor 保留为摘要查看器，不能无损导入其已经按会话合并的摘要为多条工作事项。迁移必须从明确的旧待办、原始消息和产物逐项登记，不猜测状态，不自动把已有临时配置导入。

MCP 目前仍是既有七工具。v1 没有扩展 DSH HTTP 服务、没有新增原生 task_report 工具，也没有自动唤醒 Codex 的通用宿主适配。旧自然语言反馈只进入 observation；代理核实后显式 add/event，或未来使用结构化生产者适配器。跨主机身份探测、长期守护进程、通用可视化配置和自动化生命周期仍需后续接入验证。

## 本版验收矩阵

- 同会话多事项、通知清空但工作仍 ready。
- 多观察者通知隔离、非 controller 无法 claim。
- observe/assist/managed，审批绑定修订，越界资源拒绝。
- 文档型无 Git 完成、证据缺失拒绝、依赖未完成拒绝。
- 复审往返、事件重放/载荷冲突、旧 revision/epoch 不推进。
- 并发 claim、租约过期、旧执行者失效。
- 授权撤销、总控转交后不继承权限、会话 rebind。
- 丢响应、不重复发送、显式对账、交接回执要求。
- 在途撤销后保留真实回执但阻止旧授权收尾。
- 发送后过期不自动重派，本地取消不冒充远端取消。
- 多条采集消息保留、游标与事件同事务、失败后重拉。
- 事件先于 wait 到达、旧结果不覆盖新请求。
- 上游修订影响已运行/完成下游时拒绝隐式沿用；依赖循环拒绝。
- 损坏数据/磁盘错误/预算边界；CLI 输入与连接绑定。

这些是离线控制面测试，不证明真实宿主的事件生产、后台唤醒、权限隔离或业务验收已完成。

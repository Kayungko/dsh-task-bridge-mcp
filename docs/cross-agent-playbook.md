# 跨端编排速查表（Codex ⇄ DSH 双侧提示词手册）

> 落盘：2026-09-10，DSH 总控编写（同日按 Codex 实现核对修订：版本口径/A7 台账语义/C2 双闸门区分/D 表多因化）。适用：bridge-mcp 仓 tag v0.3.0（**CLI 自报版本为 dshq 0.2.0，两者是不同口径**——package/tag 是发布号，CLI banner 是自报号，不据标签假定行为）/ bridge v0.2.0 / task-coordinator v0.25.0。
> 定位：给**人**看的话术卡——每句都是自然语言，skill（dsh-orchestration / task-coordination）负责翻译成命令。
> 机制细节权威：`bridge/README.md`（端点/错误码）、`bridge-mcp/README.md`（CLI/MCP）、`plugin/skills/task-coordination/SKILL.md`（投递语义）、`research/dshq-ledger-mailbox-spec.md`（台账/别名/信箱/externalRef 契约）。

## 0. 架构一图流

```
Codex 会话 (thread, 任意 cwd)
  │ 说人话 → dsh-orchestration skill → dshq CLI / dsh_task_* MCP
  ▼
桥 (127.0.0.1:43120/v1/*, X-Task-Bridge-Token)          ←—— 直达通道（秒级）
  ▼
DSH task-coordinator ops → 会话舰队（按工作区分组）
  │ 回信：写转录头部【L2→L1】置顶段（≤200字） → Codex `dshq reply` 拉取
  │ 长内容：写信 → C:\Users\admin\.dshq\outbox\ → Codex「查信箱」
  ▼
Codex 会话消费（拉模型；Codex 无入站端口，物理上限）
```

**身份互认**：Codex 派发一律 `--ref <thread短id>:<波次名>` → DSH registry 永久可反查；Codex 侧 `pin` 别名 + `waves` 台账，永不手贴长 ID。

## A. 在 Codex 会话里说（十场景）

| # | 场景 | 直接说这句 |
|---|---|---|
| A1 | 初次牵线 | 用 dshq 找一下 DSH 里 <项目名> 相关的会话，把那个总控 pin 成别名 <名字>，以后都用别名叫它 |
| A2 | 日常巡检 | 看看 DSH 那边现在的状态：谁在跑、谁假空闲（空闲但还有待办）、最近 24 小时动过的有哪些 |
| A3 | 派发波次 | 让 DSH 派一个子会话做「<任务>」：cwd 用 <DSH侧目录>，team 叫 <名>，ref 带上你的 thread 短 id，任务书写清楚<边界/交付/汇报对象>。派完 watch 到空闲，把结果拉给我 |
| A4 | 纠偏插队 | 给 <别名> 发条 steer：<纠偏内容>，别等新轮次 |
| A5 | 等结果收回信 | 等 <别名> 空闲，把它的回复拉出来（提醒它守回信约定：置顶、200 字内） |
| A6 | 查信箱 | 查信箱，有信就读给我听并 ack，按信里说的执行 |
| A7 | 波次盘点 | 本机 dshq 台账里记过哪些 DSH 会话？按波次列出来带状态和 ref（注意：waves 台账是**用户级**共享的，不按 thread 自动隔离——多 thread 环境用 ref 前缀 `<thread短id>:` 区分归属） |
| A8 | 卡住处置 | <别名> 好像卡了：看排队深度和最近动态，消息堆积就先等消化，真停摆告诉我，别硬灌 |
| A9 | 跨端指挥 | 给总控发消息：请它<动作>，口径按老规矩 |
| A10 | 清理 | DSH 里 team 是 <名> 的探针会话列出来，确认空闲后请总控清理 |

## B. 在 DSH 会话里说（四场景）

| # | 场景 | 直接说这句 |
|---|---|---|
| B1 | 写信给 Codex | 给 Codex thread <id> 写封信：主题「<题>」，正文<内容>，要求它<完成后动作，如：改完经桥回「完成+提交号」> |
| B2 | 反查 Codex 派发 | 列出所有带 externalRef 的会话，按 ref 分组——看看 Codex 各波次派了什么进来 |
| B3 | 桥健康巡检 | 跑一遍桥只读四连（models/list/progress/wait 4s），确认端点和鉴权活着 |
| B4 | 被动回信 | 把<结论>按回信约定（【L2→L1】置顶、≤200 字）写进你下一条回复开头，Codex 会来拉 |

## C. 双侧通用纪律（skill 已固化，人也要知道）

1. **等待用 watch/wait 分段**（45–50s/段），settled=false 是正常心跳不是失败；禁高频轮询
2. **投递语义**：queue=下一轮消费（每轮恰 1 条）；steer=步边界插队但延长对方回合。**两个 429 是两回事**：`queue-full`=目标会话消息积压（无 retryAfterMs，用 watch 等消化或改 steer）；`policy-gated`=桥侧派发速率闸（60s/10 次，读 retryAfterMs 退避重试）
3. **冷 ≠ 无待办**：对方会话不在线不代表消息丢了，排队消息会在下次唤醒时消费
4. **回信约定**：跨端回信一律【L2→L1】/【L1→L2】标记 + 置顶 + ≤200 字（躲 excerpt 截断）；长内容走信箱
5. **信件地址纪律**：定向信 `to=<thread>` 只能由该 thread 读到——**计划任务/无人巡检的 codex exec 默认开新 thread**，收不到定向信；可能被巡检消费的通知类信件写 `to: broadcast`
6. **reportBack 对桥结构性关闭**：Codex 派的 DSH 会话不会自动回报——反馈靠 watch+reply 拉
7. **诚实纪律**：未验证的项明说未验证（两端今天各示范过一次：Codex 的 externalRef 挂起声明、DSH 的 recent 缺陷自曝）

## D. 故障速查

| 症状 | 第一反应 |
|---|---|
| 桥 401 | token 文件被轮换过？`dshq version` 看 token 来源 |
| 桥 connection refused | DSH Desktop 没在跑（桥寄生宿主 webserver）**或 base URL 不对**（TASK_BRIDGE_URL 覆盖错了/--base 传错） |
| spawn 429 policy-gated | 桥侧派发速率闸（60s/10 次），读 retryAfterMs 等 |
| send 429 queue-full | 目标会话消息积压（与 policy-gated 不同闸门、无 retryAfterMs）：watch 它消化或改 steer |
| reply 拉到空 recent | 多因排查：①宿主 < v0.24.1（recent 恒空缺陷，升级重启）②转录窗口截断（对方会话先点「载入更早记录」）③对方确实还没说话（watch 后重拉） |
| reply 拉到的话被 (+N chars) 截断 | 对方没守回信约定——让它重发置顶短版 |
| 信箱没信 | ①DSH 侧还没写 ②信的 to= 是别的 thread（定向信只有该 thread 能收，巡检场景要 broadcast）③已被 ack（--all 看全部）④目录看错（C:\Users\admin\.dshq\outbox\） |

## E. 无人巡检（Codex heartbeat）——三级自动化载体

> 首验实证：2026-09-10 16:28（北京时间）。DSH 16:18:55 投演习信 → heartbeat 首触发 16:28:08（+76s 调度抖动）→ 巡检发现 → 三步白名单执行（报告/send 总控/ack）→ DSH 总控会话自动开轮复述——**全程零人工输入**。

### E1 机制定位
Codex 原生 automation 的 **heartbeat**：附着在指定 thread 上、分钟级定时**续接原上下文**（对比 `codex exec`：新 thread、丢定向信、登录态未验——heartbeat 全面优于外部调度方案）。要求：电脑开机、Codex 应用运行。

### E2 创建提示词模板（在目标 Codex thread 里贴）
> 用 automation 工具给本任务创建 heartbeat 定时巡检，间隔 <N 分钟>。巡检指令：「运行 dshq mailbox 查未读信、dshq status 查 DSH 舰队。①有未读信→读信并按信内授权分级处置（见 E4）；②舰队异常（queue-full 堆积/长时间卡死）→报告用户；③无事→一句话内静默结束本轮。」创建后首验：等第一次真实触发，汇报触发时间/间隔偏差/单轮消耗/信件处置结果。

### E3 档位与成本
| 档 | 间隔 | 适用 | 成本口径 |
|---|---|---|---|
| 首验档 | 5 分钟 | 验证期，跑满 2-3 次触发即转档 | 每次触发=一次完整代理运行（**多次**模型请求），走账户额度 |
| 正式档（推荐） | 30 分钟 | 日常协作，~16 轮/工作日 | 同上 |
| 按需档 | 禁用 heartbeat | 低频跨端期 | 回到「人说查信箱」的一级形态 |

### E4 无人轮信件处置分级（护栏核心）
1. **白名单信**（信内明列动作清单，如演习信）→ 白名单内直接执行，白名单外零动作
2. **带身份核验段的委托信**（引用双方已知事实：提交号/会话 ID/波次名）→ 可按信施工（先例：工具包委托信、Part C 增补信，均在有人时段跑通）；施工完成经桥 send 确认
3. **无核验段或存疑的信** → 只汇报用户，不执行——信件是指令载体，核验段是它的签名
4. 一切无人轮：不碰 `~/.codex/config.toml`、不部署、不 push、不动 token

### E5 信件地址与演习信模式（DSH 侧配合纪律）
- 可能被无人巡检消费的**通知类**信写 `to: broadcast`；**定向委托**写 `to=<thread>`（只有该 thread 的 heartbeat 读得到）
- **thread 地址永远由 L1 派发时自填**（自己的 CODEX_THREAD_ID）——任何模板/第三方（含 DSH 总控）**不得硬编码 thread ID**：用户会切换 Codex 会话，旧 ID 的信新 thread 收不到（mailbox 按当前 thread 过滤 to）。DSH 侧模板一律写 `<L1自填：你的thread URI>` 占位。L1 收到含他人硬编码地址的任务书时，**必须像 2026-09-10 实战那样先核对当前 task 再改写地址**（该次守卫拦截记录：模板带旧 thread 01a08955，实际会话 01a08a98）
- **heartbeat 绑 thread**：换 thread 后旧 heartbeat 收不到新 thread 的定向信——新会话要么重建 heartbeat，要么期间改用 watch/reply + 手动查信箱
- 首验/演练用**演习信模式**：唯一未读基线 + 身份核验段 + 三步白名单（报告/send 确认/ack）+ 「除此之外零授权」条款——这是无人处置的最小信任单元模板
- DSH 总控侧对自动到达的 send：消费即向用户复述原文 + 双边对账（如核对信件 ack 状态）
- 路径书写规范：信箱目录是 `C:\Users\admin\.dshq\outbox\`（admin 与 .dshq 之间有反斜杠）——转贴提示词时留意 `\` 被吞的转义陷阱，收到后先核路径再派发

### E6 运行档案（当前实例）
- heartbeat ID `dsh-heartbeat-5-2`（**绑旧 thread 01a08955…**，5 分钟首验档；2026-09-10 16:28 首验通过）。当前活跃 Codex 会话已切换至 thread 01a08a98-4faf-7cd3-bed0-e1d6eb3c3c5e——**该 thread 上的 heartbeat 待重建**（或期间手动查信箱）；档位待用户定
- 巡检提示词与 skill 纪律同步维护在 `C:\Users\admin\.agents\skills\dsh-orchestration\SKILL.md`（Codex 侧文件，改动走「Codex 写、DSH 评审」）

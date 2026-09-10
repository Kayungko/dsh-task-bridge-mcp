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

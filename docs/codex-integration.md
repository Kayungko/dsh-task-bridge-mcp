# Codex 接入增量契约（未发布）

此文档描述仓库源码中的能力，不证明运行中实例已升级。旧的六个业务端点与八种桥错误码保留；新增一个只读查询端点。

## 运行能力与派发

先用 `dsh_task_capabilities` 或 `dshq capabilities --json` 查询 `GET /v1/capabilities`。
鉴权与其他桥端点相同，返回 `protocolVersion:1`、`bridgeVersion`、`coordinatorVersion`、`coordinatorEnabled`、`capabilities`、`limits`。
coordinator 缺席/禁用时仍可诊断，但 `coordinatorEnabled:false` 且能力集合为空；能力缺席意味着未知或不支持，不能从安装记录推断可用。旧桥没有此端点时 capabilities 明确报错；CLI version 仅在该端点返回 HTTP 404 时回退查询 models 验证可达性，版本和能力返回 null，不将未知视为支持。其他错误不回退。原六端点仍可按旧契约独立使用。

MCP 和 CLI 都支持可选 `externalRef`（CLI `--ref`）：trim 后最多 200 字符，空白为缺席。它是自由文本的分组标识，不是认证身份或幂等键。
建议派发时显式提供完整外部任务 ID 与波次名组成的唯一标识，并提供 `cwd`。缺省目录来自桥的 `defaultCwd` 或宿主用户目录，不继承 Codex 工作目录。

CLI 和 MCP 共用 `src/transport.mjs`：只允许无凭据的回环 HTTP(S) 根地址、不跟随重定向、超时覆盖响应体、每请求重读 token、返回内容脱敏、异常不输出原始响应体。MCP 取消通知中止对应 HTTP 请求；**取消请求不等于取消已经发生的派发或远端任务**。写请求结果不确定时先对账，禁止盲目重发。

## 等待与增量反馈

`wait` 先检查任务存在性和目标资格：不存在返回 `not-found` / `upstreamCode:target-not-found`，真实冷会话才返回 `cold-idle`。列表不可用、远端仍运行但没有可观测 agent 时返回 `upstream-error` / `upstreamCode:wait-failed`。`settled:true` 只证明本次等待的空闲条件达到，不代表工作验收通过。

`progress` 新增可选参数 `cursor`、`messageId`；CLI 对应 `--cursor`、`--message-id`，建议配合 `--json`。旧调用仍获得原有 `recent`。有游标的调用将 `recent` 置空，增量内容只在 `feedback.messages`，避免重复回收。

`feedback` 字段：

| 字段 | 含义 |
|---|---|
| `messages` | 有界消息摘要，含可证实的 `seq`、`messageId`、`reference`、角色、文本与 `truncated` |
| `nextCursor` | 不透明、绑定目标会话的下一次游标；原样保存和回传，不自行拼接 |
| `hasMore` | 当前快照还有未读增量，继续用返回游标读取 |
| `coverage` | `complete` 仅表示本页扫描区间完整；`partial` 表示初始尾部或事件存在缺口；`unavailable` 表示无法建立可靠序列 |
| `summary` | 本页最后一条助手消息的摘要；模型产出，不是执行或验收判定 |

活跃会话每次最多扫描 400 个事件；页面消息数和摘录长度沿用配置。默认从尾部开始，不能把初始 `partial` 当成全历史。旧宿主没有可靠 seq 或读失败时不给可推进游标；冷会话仍使用既有 inspect 降级，不能声称这条路径是有界宿主分页。截断长文继续使用文件信箱/产物引用。

`consumption` 仅在指定 `messageId` 时返回：`queued`=当前队列中找到；`observed`=扫描转录中找到同 ID 用户消息；`unknown`=当前证据不足。`observed` 不证明模型已执行该指令，更不证明任务完成。

## 外部编排与回执

coordinator 的内部 caller 仍为 `task-bridge-external`。只读编排投影按完整 `externalRef` 派生不透明外部分组 ID，不输出原始 ref；同 team 不会混合不同 ref。旧任务没有 ref 时按各自任务隔离，并标记来源未知。

外部根节点是展示节点，不能当作可导航、可发送消息的 DSH 会话。原生 DSH 父子链保持原样。关联字段不提供授权，也不声称验证过外部调用方身份。

桥派发/投递成功后，coordinator 为已登记任务记录 `bridgeReceipts`：只含顺序号、时间、种类、消息/关联 ID、模式及投递结果，每任务最多 100 条，随 registry 持久化。回执携带 `receiptPersisted`，为 false 时派发可能已成功但记账失败，不能重派。未登记目标不会被强行改归属。

编排历史查询对于外部父节点读取这些回执，每页 30 条，返回 `source:bridge-receipts`、`coverage:partial`。历史旧记录、信箱回信、模型消费状态不从投递回执补造。原生父节点继续走宿主分页。

## 兼容与验证

新桥对带 cursor/messageId 的请求要求运行中 coordinator 声明 `progressCursor:true`，否则明确返回 `upstream-error / capability-unavailable`，不会让旧实现静默忽略。没有这些参数的 progress 调用保持兼容。

新模块必须随源码部署：MCP 的 `transport.mjs`、`contract.mjs`；coordinator 的 `feedback.mjs`、`external.mjs`。测试入口为各仓 `npm test`（桥使用 `npm run smoke`）。部署、重启装载、真实 Codex 调用、GUI 与信箱实机闭环需另行验证；本次不自动修改用户配置或扩大派发授权。

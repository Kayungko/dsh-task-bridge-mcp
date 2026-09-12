# dsh-task-bridge-mcp

Codex 侧 MCP stdio wrapper：把 [dsh-plugin-task-bridge](../bridge)（DSH Desktop 的
Codex→DSH 控制面桥接插件）的 REST 端点包装成 Codex 可调用的 MCP 工具。

```
Codex CLI ──MCP stdio(JSON-RPC)──> dsh-task-bridge-mcp ──HTTP(fetch)──> 桥 /v1/* 端点 ──> DSH task-coordinator ops
```

- 设计蓝图：[`research/task-bridge-reanchoring.md`](../research/task-bridge-reanchoring.md) §4（MCP stdio wrapper 推荐）+ §3（端点清单与回执字段）。
- **零运行时依赖**（见下方选型说明），Node.js ≥ 18.17（用内置 fetch / AbortController / readline）。

当前源码新增能力查询、MCP/CLI 统一传输及增量反馈，见 [Codex 接入增量契约](docs/codex-integration.md)。运行状态以 capabilities 回执为准。

长时间监控可用 `dshq monitor run/read/ack/status/stop`：本地静默检查，按 Codex 任务隔离游标与摘要，不调用模型。用法和边界见 [本地静默监控器](docs/local-monitor.md)。

## SDK 选型说明：手写 JSON-RPC，不用 @modelcontextprotocol/sdk

按蓝图 §4 结论二选一，本项目选手写 JSON-RPC 2.0，理由：

1. **协议面极小且稳定**：本 wrapper 只需实现 `initialize`（含 `instructions`）/
   `tools/list` / `tools/call` / `ping` 四个方法 + 请求取消通知处理，NDJSON 行协议即全部复杂度。
   SDK 的传输抽象、能力协商、资源/提示等能力对本场景是死重。
2. **零依赖 = 零安装**：Codex 直接 `node …/src/server.mjs` 启动，无需 `npm install`，
   bring-up 阶段零摩擦；也避免供应链与 SDK 版本钉扎问题。
3. **可审计性**：~600 行含注释的源码一屏可读，安全边界（token 处理、错误映射）肉眼可查。

代价：协议版本协商需自己维护（`src/server.mjs` 的 `SUPPORTED_PROTOCOL_VERSIONS`）。
MCP stdio 协议面变化时需要手动跟进——对单消费方（Codex CLI）的定向 wrapper 可接受。

## 安装

```powershell
# 1. 取得代码（本仓库即代码本体，无需构建步骤）
git clone <repo> D:\git\DHS-Tool\bridge-mcp   # 或已就位

# 2. 无依赖可装；如需跑离线测试：
cd D:\git\DHS-Tool\bridge-mcp
npm test        # MCP/CLI 离线回归（mock REST server，不依赖真桥）
```

运行要求：Node.js ≥ 18.17；DSH Desktop 运行中且 dsh-plugin-task-bridge 已启用
（真桥 bring-up 后才可用，见「已知限制」）。

## Codex 配置（~/.codex/config.toml 片段）

> 本项目**不自动修改**用户 `~/.codex/config.toml`；以下为手工添加的片段示例。
> 字段口径来自 Codex MCP 官方文档（蓝图 §4.2 已验证）：`command`/`args`/`env`、
> `startup_timeout_sec`（默认 10）、`tool_timeout_sec`（默认 60）、`enabled_tools`、
> `default_tools_approval_mode`。

```toml
[mcp_servers.dsh-task-bridge]
command = "node"
args = ["D:/git/DHS-Tool/bridge-mcp/src/server.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 60          # wrapper 的 wait 工具已按 50s 上限钳制，60s 默认值够用

# token 默认从 C:\Users\<你>\.dsh\task-bridge-token 文件读取（wrapper 内置逻辑），
# 因此**无需**把 token 写进本文件。仅当需要覆盖时才加 env，例：
# env = { TASK_BRIDGE_URL = "http://127.0.0.1:43120",
#         TASK_BRIDGE_TOKEN_FILE = "D:/somewhere/other-token-file" }

# 可选：工具白名单（与桥端点白名单对齐）
# enabled_tools = [
#   "dsh_task_spawn", "dsh_task_send", "dsh_task_progress",
#   "dsh_task_wait",  "dsh_task_list", "dsh_task_models", "dsh_task_capabilities",
# ]

# 可选：写操作保留 Codex 侧人工批准门（与 DSH 侧策略闸双层呼应，蓝图 §4.3）
# default_tools_approval_mode = "prompt"
```

配置后用 `codex mcp list`（或 TUI `/mcp`）确认 `dsh-task-bridge` 已挂载。

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `TASK_BRIDGE_URL` | 桥 REST base URL | `http://127.0.0.1:43120` |
| `TASK_BRIDGE_TOKEN` | 桥鉴权 token（明文值，优先级最高） | 不设置 |
| `TASK_BRIDGE_TOKEN_FILE` | token 文件路径 | `C:\Users\<你>\.dsh\task-bridge-token` |

token 解析顺序：`TASK_BRIDGE_TOKEN` > `TASK_BRIDGE_TOKEN_FILE` > 默认文件路径；
每次请求前惰性重读（桥重启轮换 token 后无需重启 wrapper）。

## 工具清单（镜像桥 MVP 6 端点）

桥端点 `cancel` 属第二批（蓝图 §0.2），本版本**不提供** `dsh_task_cancel`
（调用会得到 JSON-RPC `-32602` Unknown tool）。

| 工具 | 桥端点 | 参数 | 回执关键字段 |
|---|---|---|---|
| `dsh_task_spawn` | POST `/v1/spawn` | `prompt`*（自包含 kickoff 指令）；`title`/`team`/`cwd`/`provider`/`model`/`reasoningEffort` 可选。**不暴露 `reportBack`（结构性关闭）** | `sessionId`、`workspace` `{id,title}\|null`、`placement`（五级）、`model`+`modelSource`（explicit/plugin-default/host-default）、`correlationId`、`depth`；失败 code=`upstream-error`（`upstreamCode=model-select-failed`/`kickoff-rejected` 时含孤儿 `sessionId`）/`policy-gated`/`bad-request` |
| `dsh_task_send` | POST `/v1/send`（工具面 `message` → wire 字段 `text`） | `sessionId`*、`message`*；`mode`（queue/steer）、`reference` 可选 | `delivered`、`targetId`、`mode`、`messageId`、`queueDepth` `{nextTurn,nextStep}`、`placement`（next-step/next-turn）、`targetStatus`；失败 code=`rate-limited`/`queue-full`/`not-found`/`bad-request` |
| `dsh_task_progress` | GET `/v1/progress` | `sessionId`* | `agentState`（idle/running/cold-idle）、`updatedAt`、`queue`、`recent`（尾部摘要）、`todos`、`goal`、`seq`、`inspectError` |
| `dsh_task_wait` | GET `/v1/wait` | `sessionIds`*（单值或数组）；`mode`（all/any）、`timeoutMs`（默认 45000，**钳制 ≤50000**） | `settled`（false=正常心跳，续 call 即可）、`reason`、`waitedMs`、`count`、`targets[]` |
| `dsh_task_list` | GET `/v1/list` | `filter`/`team`/`includeSubagents`/`ungrouped`/`limit` 全可选 | `tasks[]`、`truncated` |
| `dsh_task_models` | GET `/v1/models` | 无 | `providers[]`、`default`、`pluginDefault`、`failedProviders` |

\* 必填。每个工具的 description 内嵌完整的参数与回执字段说明（Codex 端模型可直接读到）。

### 用法示例（拉模型循环）

```
1. dsh_task_models {}                          → 取合法 provider/model id（绝不猜）
2. dsh_task_spawn {prompt:"…自包含指令…", title:"修复｜对账精度", team:"bridge-mvp"}
   → 回执 placement/modelSource 不符预期 → 停止处置；含 warning（ungrouped）→ 先补救
3. dsh_task_wait {sessionIds:"<sessionId>"}     → settled:false（45s 心跳）→ 继续 call
4. settled:true → dsh_task_progress {sessionId} → 读 recent/todos/goal 判断结果
5. 需纠偏 → dsh_task_send {sessionId, message:"…", mode:"steer"}
   → queueDepth.nextTurn>=2 说明排得深，改 steer 或等一轮
```

### 错误信封

桥应答 `{ok:false, code, error}` 一律转成 **MCP tool error**（`isError:true`），
`code`+`error` 原样透传（信封附加字段如 `retryAfterMs`、`upstreamCode`、孤儿
`sessionId` 一并透传），**绝不吞错**。桥端 `code` 为八值稳定枚举
（`unauthorized`/`forbidden-body`/`bad-request`/`policy-gated`/`rate-limited`/
`queue-full`/`not-found`/`upstream-error`，权威表见桥 README）。wrapper 自身错误码：
`token-missing` / `bridge-unreachable` / `bridge-timeout` / `bridge-http-error` /
`bridge-invalid-response` / `invalid-params` / `internal-error`。
完整处置表见 [`skills/dsh-task-bridge/SKILL.md`](skills/dsh-task-bridge/SKILL.md)。

## 安全注意事项

- **token 不进 argv**：鉴权 token 只经环境变量或 token 文件注入，绝不出现在命令行参数
  （argv 对本机所有进程可见）；`codex mcp add` 时也只写 `command`/`args`（脚本路径），不写 token。
- **token 不落日志**：wrapper 的错误信息、stderr 横幅、MCP 回执均不含 token 值；
  token 仅作为 `X-Task-Bridge-Token` 请求头发往桥。
- **token 不进配置明文**：推荐默认文件路径（`~/.dsh/task-bridge-token`）而非
  `env = { TASK_BRIDGE_TOKEN = "…" }`（后者会把明文落进 `config.toml`）。
- **回环限定**：默认 base URL 为 `127.0.0.1:43120`；桥侧另有回环自检（蓝图 §2.4）。
- **测试脱敏**：仓库内测试与文档的 token 一律为合成假值（`FAKE-TOKEN-*`），
  绝不读取真实 token 文件内容。

## 开发与测试

```powershell
npm run check   # node --check 全部源文件
npm test        # 离线 smoke：node:http mock REST server，10 个用例全绿，不依赖真桥
```

目录结构：

```
src/server.mjs   MCP stdio 入口（JSON-RPC 循环 + 错误映射）
src/client.mjs   REST client（token 解析 / fetch 超时 / 信封错误映射）
src/tools.mjs    7 工具定义（inputSchema/description/handler）+ instructions
test/smoke.mjs   离线 smoke 测试（mock 桥）
skills/dsh-task-bridge/SKILL.md   Codex 侧使用纪律（拉模型/策略闸/回执解读/错误码表）
```

## dshq CLI

`cli/dshq.mjs` 为 Codex 侧编排 CLI v0.1.0（零 npm 依赖 Node ESM，Node.js ≥18.17）。
消费六个业务 REST 端点和只读 capabilities 端点，不修改 MCP 配置或宿主。PowerShell 当前进程可定义：

```powershell
function dshq { & node 'D:\git\DHS-Tool\bridge-mcp\cli\dshq.mjs' @args }
dshq version
dshq status
dshq list --team task-bridge
dshq reply 95a2abaf
```

| 命令 | 参数与用途 |
|---|---|
| status | 舰队总数、running、空闲但有待办、24h 活跃数；各组最多显示 5 条，--json 取完整已返回集合 |
| list | `--team T --filter S --ungrouped --all`；默认隐藏 blank，--all 显示全部返回条目 |
| find | `<子串>`，查询候选，不执行投递 |
| progress | `<会话>`，状态/队列/todos/goal/recent；--json 保留原信封 |
| reply | `<会话> --lines N`，只显示 assistant 尾部 N 条（默认 3） |
| spawn | `<prompt> --title T --team M --cwd D --model P/M --watch --auto-retry`；选项均可省略 |
| send | `<会话> <text> --steer --reference R`；wire 字段为 text，默认 queue |
| watch | `<会话…> --mode all或any --until-idle --max-min M`；默认 all、10 分钟 |
| models | 路线目录、default/pluginDefault；指定路线前先查真实 ID |
| version | CLI 版本、GET models 可达性、token 来源类型（绝不显示值） |

全局 `--json`、`--base <url>`、`--timeout <ms>`、`--help` 可放命令前后。
token 优先级与 MCP 相同，每请求惰性重读；base 优先级为 `--base` > TASK_BRIDGE_URL > 默认。
CLI 限制为无凭据的回环 HTTP(S) base，禁用重定向；所有输出统一掩盖已用 token 和 64hex 形态。
不提供 token argv 选项，不启动包含 token 的子进程。

会话三态：完整 `session-…` 直通；8 位短 ID 从 `list?limit=500` 匹配 shortId/ID；
其余对 title/team 做忽略大小写的子串匹配。唯一命中采用并回显全 ID，多命中列候选退 3，
零命中退 1 并提示 list；列表被截断时拒绝自动解析，先过滤 list 再用完整 ID。

```powershell
dshq find '总控'
dshq progress 95a2abaf --json
dshq spawn '只回复一句话后结束回合，不调用工具。' --title '探索｜编排探针' --team dshq-shakedown --cwd 'D:\git\DHS-Tool' --watch
```

`watch` 每次 wait 默认 45000ms（`--timeout` 可缩短，上限 45000ms），
请求另留最多 5000ms 网络余量；`settled:false` 打印心跳并继续。
`--until-idle` 是默认行为的显式同义选项。结束时 progress 拉各目标的最后一条 assistant 回复，
`--mode any` 下其他目标可能仍在运行。`--max-min` 限制等待预算，最终 progress 快照请求
可再占各自的 `--timeout` 时间；预算耗尽为本地 watch-timeout，退 1，附已读 progress。
`spawn --watch` 保留完整派发回执（placement/workspace/modelSource/warning 等），再等并拉回复。
调用方须核对落位及模型，空闲不能直接作为任务完成证据。

`--json` stdout 恰好一个 JSON 对象，心跳/中途 spawn 回执/投递提示写 stderr：
progress 为桥信封；reply 为 `{ok,sessionId,recent,notes}`；watch 为 wait 信封加
`sessionIds,rounds,timedOut,progress`；spawn --watch 为 `{ok,spawn,watch}`。
敏感输出脱敏仍适用于 JSON。exit 0 成功，1 本地参数/网络/协议/等待预算错误，
2 桥八值错误，3 ID 歧义。错误输出含 code/error/advice 与桥补救字段。

只有 `spawn --auto-retry` 对 policy-gated 按 retryAfterMs 等待，最多重试 3 次；
spawn-depth-exceeded 不重试。rate-limited、queue-full、网络失败均不自动重发，
先 progress/list 对账，避免重复投递或孤儿会话。

**回信约定**：DSH 将【L2→L1】回信独立成段放在助手消息开头，全文 ≤200 字。
reply 保留 `(+N chars)` 摘录截断标记，提示「请 DSH 重发短回信」，不猜测缺失内容。
recent 为空会提示检查是否有转录，以及宿主是否已重启到 task-coordinator v0.24.1+。

本机配套 skill：`C:\Users\admin\.agents\skills\dsh-orchestration\SKILL.md`（仓库外独立安装）。
规格基线：上级 research/codex-side-toolkit-spec.md，提交 `0965cfe`。

离线验收：

```powershell
node cli/test/smoke.mjs
```

mock HTTP 桥覆盖十命令、ID 三态、send.text、八值错误、token 三来源/轮换/脱敏、
watch 收敛/预算耗尽、策略闸退避和 JSON/进程退出码；不接触真实 token 或真实 DSH 任务。

## 已知限制（以下为原 MCP wrapper 的历史未验证项，非 dshq CLI 验收结论）

1. **未与真桥实机联调**：REST 端点形状已按桥端 `D:\git\DHS-Tool\bridge` README
   （v0.1.0）的端点对照表逐项核对（wire 字段名、参数序列化、回执字段、
   错误码枚举），并同步了 send 的 `message`→`text` wire 映射；但端到端实机
   联调（真实宿主 webserver + 真实 token）留待 bring-up 阶段。
2. **Codex 实机 MCP 挂载未验证**：`config.toml` 字段实际生效行为、`instructions`
   采用度按官方文档实现（蓝图 §4.2），留待 bring-up 用 `codex mcp list` / TUI `/mcp` 验证。
3. `dsh_task_cancel` 未提供（桥第二批端点）。

## 许可

MIT

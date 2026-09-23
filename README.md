# dsh-task-bridge-mcp

> **安装前提（0.27.0 起）**：宿主侧桥端点已合并进 `dsh-plugin-task-coordinator`
> ≥0.27.0，需在「设置 → 任务编排 → 外部任务桥」打开实验开关 `bridgeEnabled` 后，本
> wrapper 才有 127.0.0.1:43120 的七个路由可连。旧独立包 `dsh-plugin-task-bridge`
> 已 DEPRECATED，**不要再去装它或找它的开关**。桥端 token 文件
> `~/.dsh/task-bridge-token` 在 coordinator **≥0.27.2 由桥自动生成**；0.27.0/0.27.1
> 上不会生成，需手工建好，否则七条路由一律回 503。
>
> 设计与冻结契约见 `research/bridge-merge-into-coordinator-design.md`（在 DHS-Tool
> 工作区内，**本仓不含该文件**）。
> **网页额度（ChatGPT Web）部署 walkthrough**：`dsh-plugin-task-coordinator` 仓的
> `docs/WEB-BRIDGE.md`（本仓同样不含）——经 OpenAI Secure MCP Tunnel 驱动本机 DSH
> 的完整三步部署、profile 模板、command 分词规则与排障速查都在那里。

Codex 侧 MCP stdio wrapper：把 [dsh-plugin-task-bridge](https://github.com/Kayungko/dsh-plugin-task-bridge)（DSH Desktop 的
Codex→DSH 控制面桥接插件；现已 DEPRECATED，宿主侧由 `dsh-plugin-task-coordinator` ≥0.27.0 内置接替）的 REST 端点包装成 Codex 可调用的 MCP 工具。

```
Codex CLI     ──MCP stdio(JSON-RPC)──> dsh-task-bridge-mcp ──HTTP(fetch)──> 桥 /v1/* 端点 ──> DSH task-coordinator ops
ChatGPT 网页  ──OpenAI Secure MCP Tunnel──> tunnel-client ──MCP stdio──> 本包 ──HTTP(fetch)──> 同上
```

- 设计蓝图：`research/task-bridge-reanchoring.md` §4（MCP stdio wrapper 推荐）+ §3（端点清单与回执字段）——在 DHS-Tool 工作区内，本仓不含。
- **零运行时依赖**（见下方选型说明），Node.js ≥ 18.17（用内置 fetch / AbortController / readline）。

当前源码新增能力查询、MCP/CLI 统一传输及增量反馈，见 [Codex 接入增量契约](docs/codex-integration.md)。运行状态以 capabilities 回执为准。

长时间监控可用 `dshq monitor run/read/ack/status/stop`：本地静默检查，按 Codex 任务隔离游标与摘要，不调用模型。用法和边界见 [本地静默监控器](docs/local-monitor.md)。

通用多事项协作新增 `dshq workflow`：持久事项独立于会话，支持通知隔离、授权模式、领取/复审/转交及外部发送对账。先读 [工作流 v1 契约](docs/workflow-v1.md)，需要总控模板时再读 [代理推进模板](docs/workflow-agent-template.md)。首版是本地 CLI 控制面，不自动迁移已有任务或启动自动化。

## 编排 Skill 源码与待部署包

通用入口维护在 [dsh-orchestration](skills/dsh-orchestration/SKILL.md)，按需加载单步操作、监控、工作流和桥接协议。旧 [dsh-task-bridge](skills/dsh-task-bridge/SKILL.md) 保留为协议参考；部署包只有一个可发现的 Skill，避免双入口重复加载。

```powershell
node scripts/package-skills.mjs --out '<绝对路径的空暂存目录>'
node '<暂存目录>/dsh-orchestration/scripts/dshq.mjs' --help
```

打包器仅准备文件，拒绝写入源码、全局技能和 DSH 目录，拒绝覆盖非空输出。产物包含自带 CLI/MCP 运行代码的 `dsh-orchestration/` 和 SHA-256 清单 `bundle-manifest.json`，不复制凭据、用户配置或任务状态，无需 npm install。清单用于核对内容，不证明产物已经安装。

待用户授权部署时，再核对并备份现有技能及其本地定制，部署完整技能目录；只复制 SKILL.md 会缺少引用和运行代码。DSH 插件部署、宿主重启、既有自动化及工作流迁移分别核验，不由打包器执行。仓库源码入口定位同仓 CLI，完整技能包优先使用内嵌运行代码；只有显式设置 DSHQ_HOME 时才改用指定工具包。

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
git clone https://github.com/Kayungko/dsh-task-bridge-mcp.git
cd dsh-task-bridge-mcp

# 2. 无依赖可装；如需跑离线测试：
npm test        # MCP/CLI 离线回归（mock REST server，不依赖真桥）
```

> 下文示例统一用 `<bridge-mcp>` 代表你实际的克隆目录。**克隆路径尽量避开空格与非 ASCII 字符**——tunnel-client 的 `command:` 串按空白切分、且不做变量展开（实测规则见 coordinator 仓 `docs/WEB-BRIDGE.md`）。

### 让 profile 里不出现仓库绝对路径（推荐）

写进 tunnel-client profile 的 `command:` 是绝对路径，仓库一挪就得改。做一次全局安装即可彻底解耦：

```powershell
npm i -g <bridge-mcp>       # 拷贝安装：仓库移动/重克隆都不影响
# 或 npm link <bridge-mcp>  # 符号链接：跟随仓库改动（开发态方便，但仓库一挪就断）
npm root -g                 # 查全局 node_modules 位置
```

之后 profile 只需写 `command: 'dsh-task-bridge-mcp'`（走 PATH 里的 npm shim，shim 按自身目录相对解析，与仓库位置无关）。若不想依赖 `.cmd` shim，可写 `node <npm root -g 输出>/dsh-task-bridge-mcp/src/server.mjs`——执行链与 clone 形态完全同构，不引入新的失败模式。

> **本包尚未发布到 npm registry**（2026-09-23 核实返回 404），因此 `npx -y dsh-task-bridge-mcp` 今天不可用。`package.json` 的 `bin` 与 `src/server.mjs` 的 shebang 都已就位，发布后即可用；但 `npx -y` 首跑要联网下载解包，会把 MCP 启动从毫秒级拖到秒级、离线即不可用——常驻链路不建议。

运行要求：Node.js ≥ 18.17；DSH Desktop 运行中，且宿主侧桥已开启——**0.27.0 起桥内置于 `dsh-plugin-task-coordinator`**，开关在 **设置 → 任务编排 → 外部任务桥 → 启用外部桥**（热生效，不重启宿主）。旧独立包 `dsh-plugin-task-bridge` 已 DEPRECATED，不要再去装它。桥端 token 文件 `~/.dsh/task-bridge-token` 在 coordinator **≥0.27.2 由桥自动生成**；0.27.0/0.27.1 上不会生成，需手工建好，否则七条路由一律回 503（建法见 coordinator 仓 `docs/WEB-BRIDGE.md`）。

### 路径写法注意（Windows）

- 写进 tunnel-client profile 的 `command:` 时，Windows 路径**必须用正斜杠**，或套 **YAML 单引号**让反斜杠字面存活。反斜杠在引号外与 YAML 双引号内都会被当转义符吃掉（`D:\git\x` → `D:gitx`），而报错只说 "script not found"，不会告诉你是反斜杠的问题。
- 写进 Codex `config.toml` 的 `args` 时正斜杠同样最稳。
- 不做 `${VAR}` / `%VAR%` / `~` 展开——全部按字面量传给子进程。

## Codex 配置（~/.codex/config.toml 片段）

> 本项目**不自动修改**用户 `~/.codex/config.toml`；以下为手工添加的片段示例。
> 字段口径来自 Codex MCP 官方文档（蓝图 §4.2 已验证）：`command`/`args`/`env`、
> `startup_timeout_sec`（默认 10）、`tool_timeout_sec`（默认 60）、`enabled_tools`、
> `default_tools_approval_mode`。

```toml
[mcp_servers.dsh-task-bridge]
command = "node"
args = ["<bridge-mcp>/src/server.mjs"]   # 例：C:/tools/dsh-task-bridge-mcp/src/server.mjs —— 正斜杠最稳
startup_timeout_sec = 10
tool_timeout_sec = 60          # wrapper 的 wait 工具已按 50s 上限钳制，60s 默认值够用

# token 默认从 C:\Users\<你>\.dsh\task-bridge-token 文件读取（wrapper 内置逻辑），
# 因此**无需**把 token 写进本文件。该文件在宿主 coordinator ≥0.27.2 由桥自动生成；
# 0.27.0/0.27.1 上不会生成，需手工建好，否则七条路由一律回 503。仅当需要覆盖时才加 env，例：
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

## 工具清单（6 业务端点 + 1 只读能力查询 = 7 工具）

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
| `dsh_task_capabilities` | GET `/v1/capabilities` | 无 | `ok`、`protocolVersion`、`bridgeVersion`、`coordinatorVersion`、`coordinatorEnabled`、`capabilities`、`endpoints[]`（7 条）、`limits`、`reportBack`、`cwdDefault`。`bridgeVersion` 与宿主插件的 `package.json` 单一版本轨锁步，是判别服务方为合并后新桥的关键值 |

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

`cli/dshq.mjs` 为 Codex 侧编排 CLI（版本随仓 tag，运行时读 package.json；零 npm 依赖 Node ESM，Node.js ≥18.17）。
消费六个业务 REST 端点和只读 capabilities 端点，不修改 MCP 配置或宿主。PowerShell 当前进程可定义：

```powershell
function dshq { & node '<bridge-mcp>\cli\dshq.mjs' @args }
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
dshq spawn '只回复一句话后结束回合，不调用工具。' --title '探索｜编排探针' --team dshq-shakedown --cwd '<你的工作区绝对路径>' --watch
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

配套 skill 源码与运行入口已随仓维护，见上方「编排 Skill 源码与待部署包」；源码更新不会替换已安装技能。
规格基线：上级 research/codex-side-toolkit-spec.md，提交 `0965cfe`。

离线验收：

```powershell
node cli/test/smoke.mjs
```

mock HTTP 桥覆盖十命令、ID 三态、send.text、八值错误、token 三来源/轮换/脱敏、
watch 收敛/预算耗尽、策略闸退避和 JSON/进程退出码；不接触真实 token 或真实 DSH 任务。

## 已知限制

1. **（历史项，2026-09-23 已实测推翻）未与真桥实机联调**：REST 端点形状曾按桥端
   `dsh-plugin-task-bridge`（宿主侧现为 `dsh-plugin-task-coordinator` ≥0.27.0）
   README v0.1.0 的端点对照表逐项核对（wire 字段名、参数序列化、回执字段、错误码
   枚举），并同步了 send 的 `message`→`text` wire 映射。**端到端实机联调已完成**：
   ChatGPT 网页 → OpenAI Secure MCP Tunnel → 本包 → 合并后桥的回传，与本地直连
   43120 逐字段一致；0.27.0 独立包硬切换时本包零改动存活、tunnel-client 无需重启
   （wire 契约冻结未变）。
2. **（部分推翻，2026-09-23）Codex 实机 MCP 挂载未验证**：MCP stdio 挂载已在
   **tunnel-client** 这条真实 stdio 链路上端到端验证（工具可见、可调用、`instructions`
   随 initialize 下发、回执与本地直连一致）。但 **Codex CLI 自身的 `config.toml` 形态**
   （字段实际生效行为、`instructions` 在 Codex 侧的采用度）本轮未重新取证，仍按官方
   文档实现（蓝图 §4.2）；用 `codex mcp list` / TUI `/mcp` 可自行验证。
3. `dsh_task_cancel` 未提供（桥第二批端点，蓝图 §0.2）——调用会得到 JSON-RPC
   `-32602` Unknown tool。**此项仍成立。**

## 许可

MIT

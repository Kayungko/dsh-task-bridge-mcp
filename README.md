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
| `DSH_BRIDGE_LOCAL_FS` | `=1` 启用 4 个本地文件工具（见下节） | **不启用** |
| `DSH_BRIDGE_LOCAL_EXEC` | `=1` 另启用 `local_exec`（本机 shell） | **不启用** |
| `DSH_BRIDGE_FS_MAX_BYTES` | 单次读取 / exec 输出字节上限 | `262144`（256KB） |
| `DSH_BRIDGE_EXEC_TIMEOUT_MS` | `local_exec` 超时上限（入参只能调小不能调大） | `30000` |
| `DSH_BRIDGE_GREP_MAX_FILES` | `local_grep` 扫描文件数上限 | `2000` |
| `DSH_BRIDGE_GREP_MAX_DEPTH` | `local_grep` / 递归列举深度上限 | `12` |
| `DSH_BRIDGE_GREP_TIMEOUT_MS` | `local_grep` **整次调用的墙上时间预算**；到点即停并置 `regexTimedOut`/`wallTimedOut` | `10000` |
| `DSH_BRIDGE_EXEC_MAX_CONCURRENT` | `local_exec` 同时在跑的命令数上限；超限立即报 `exec-busy`（不排队） | `4` |
| `DSH_BRIDGE_LOCAL_CWD` | 本地工具的缺省工作目录（同样受白名单与凭据保护约束） | bridge-mcp 进程 cwd |
| `DSH_BRIDGE_FS_DENY` | 追加路径黑名单（`path.delimiter` 分隔，按目录前缀匹配） | 不设置 |
| `DSH_BRIDGE_FS_ALLOW` | **白名单模式**：设置后所有文件工具路径与 exec 的 cwd 必须落在列出的根内（`path.delimiter` 分隔，可多根） | 不设置（不限范围） |
| `DSH_BRIDGE_FS_DENY_CREDENTIALS` | `=0` 解除默认凭据保护（启动打强告警） | 保护开启 |
| `DSH_BRIDGE_FS_ALLOW_SELF_WRITE` | `=1` 解除「禁止改写 bridge-mcp 自身包目录」保护（启动打强告警） | 保护开启 |
| `DSH_BRIDGE_AUDIT_FILE` | 审计行落盘路径（append-only，一行一条；该文件本身**不可被 `local_write_file` 改写**，且此项保护不可解除） | 不落盘，仅 stderr |

> ⚠️ **白名单只收窄、永不放宽**。`DSH_BRIDGE_FS_ALLOW` 与凭据保护是 **AND** 关系：把 home
> 加进白名单，`~/.dsh/task-bridge-token`、`~/.ssh/id_rsa`、`~/.codex/auth.json` 照样被拒。
> 它也**管不住 `local_exec`**——命令里用绝对路径（`type C:\...`）想读哪读哪。真要收窄到
> 单个项目，正确做法是只开 `DSH_BRIDGE_LOCAL_FS`、不开 `DSH_BRIDGE_LOCAL_EXEC`，再设白名单。

> ⚠️ **`DSH_BRIDGE_GREP_TIMEOUT_MS` 是「有界阻塞」不是「不阻塞」**。`local_grep` 是同步实现，
> 正则执行期间事件循环仍然是停的；这个预算把停顿从**无上界**（0.5.1 实测 `(a+)+$` 跑过 15s
> 需外部 `taskkill`）压到**有上界且到点后 server 恢复健康**。默认 10s 已接近常见 MCP
> `tool_timeout_sec`，调大前请确认客户端的超时设置。

> ⚠️ **别指望 stderr 能当审计留痕**：安全评审实测生产 `tunnel-client.log`（3.9MB debug 级、
> 覆盖两次启动）对 bridge-mcp 的 stderr **零命中**——profile 的 `mcp.commands[]` 只有
> `channel` 与 `command` 两个字段，没有 stderr 重定向口子。要事后追溯网页侧动过什么，
> 必须显式设 `DSH_BRIDGE_AUDIT_FILE`（建议放仓库外，如 `%USERPROFILE%\.dsh\bridge-audit.log`）。
> 落盘内容同样只含路径与命令原文，不含文件内容与命令输出。

token 解析顺序：`TASK_BRIDGE_TOKEN` > `TASK_BRIDGE_TOKEN_FILE` > 默认文件路径；
每次请求前惰性重读（桥重启轮换 token 后无需重启 wrapper）。

**所有 env 都在进程启动时读一次，不支持热切换**——改开关必须重启 bridge-mcp（经 tunnel-client
部署时即重启 tunnel-client）。这是有意的：能力面在进程生命周期内固定，避免"跑着跑着多出个
shell 工具"。启用时 stderr 会打一条横幅，便于在 tunnel-client 日志里确认实际生效的能力面：

```
[bridge-mcp] local tools ENABLED: local_read_file, local_write_file, local_list_dir, local_grep (maxBytes=262144, execTimeoutMs=30000, denyCredentials=true, cwd=…)
```

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

## 本地文件与命令工具（0.5.0，默认关闭）

上面的 7 个 `dsh_task_*` 工具是**任务编排**：网页/Codex 侧派活，重活由 DSH 会话里的 agent
执行，消耗的是 **DSH 侧模型额度**。本节这 5 个 `local_*` 工具是另一条路：**直接操作本机**，
不经 DSH 任务会话，因此**不消耗任何模型额度**、毫秒级返回、拿到的是文件原文而非摘要。

两种模式并存，由调用方按需选择：

| | `dsh_task_*`（任务编排） | `local_*`（直接操作本机） |
|---|---|---|
| 谁干活 | DSH 会话里的 agent | bridge-mcp 进程自己 |
| 额度 | 消耗 DSH 侧模型额度 | **零模型额度** |
| 延迟 | 秒级到分钟级（要等 agent 跑） | 毫秒级 |
| 拿到的 | agent 的转述 + 尾部摘要（默认 6 条消息） | 文件原文 / 命令原始输出 |
| 人在环 | **部分**：任务在 DSH 侧栏实时可见、可随时 steer/cancel；但桥侧单发 spawn **不弹确认卡**（确认门只覆盖 `task_spawn_batch`，见 `bridge-policy.mjs` 的设计说明），只有 60s/10 次策略闸 | **没有** |
| 适合 | 需要推理、改多处、跑测试的开发任务 | 查代码、读配置、看日志、跑一条命令 |

**默认一个都不注册**：不设 `DSH_BRIDGE_LOCAL_FS` / `DSH_BRIDGE_LOCAL_EXEC` 时 `tools/list`
仍是原来 7 个，既有链路零变化（`tools/list`、`instructions`、错误信封与桥路径逐字节相同；
`initialize` 仅 `serverInfo.version` 随版本轨道变化）。两者是独立开关，「只开文件、不开 shell」
能挡掉命令执行，但**不构成质变意义上的"安全档"**：文件写权限本身就足以达成代码执行与持久化
（写 `src/server.mjs` —— 生产 profile 直接跑工作树，下次启动即执行；写 Windows 启动项、
PowerShell profile、`~/.claude/settings.json` 的 hooks、`.git/hooks/*` 同理）。所以只开 FS 是
「更窄」而非「安全」，别把它当成可以放心不管的档位。
的形态。

| 工具 | 开关 | 参数 | 说明 |
|---|---|---|---|
| `local_read_file` | `LOCAL_FS` | `path`*、`offset`、`limit` | 读文本文件，返回带行号内容（`cat -n` 风格）+ `totalLines`/`truncatedByLimit`。超 `MAX_BYTES` 拒绝并提示分页；含 NUL 的二进制拒绝返回内容 |
| `local_write_file` | `LOCAL_FS` | `path`*、`content`*、`mode` | `overwrite`（默认）/ `append`；父目录缺失时递归创建。回执含 `existed`/`previousSize`/`newSize`，便于确认是新建还是覆盖 |
| `local_list_dir` | `LOCAL_FS` | `path`*、`recursive`、`limit` | 默认单层；递归时跳过隐藏目录且有深度上限。无权限的子目录静默跳过，不让整次列举失败 |
| `local_grep` | `LOCAL_FS` | `pattern`*、`path`、`caseInsensitive`、`onlyMatching`、`limit` | JS 正则（非 ripgrep）。自动跳过 `node_modules`/`.git`/`dist`/`build`/`coverage`、隐藏目录、二进制与超限大文件；回执含 `filesScanned`/`truncated` |
| `local_exec` | `LOCAL_EXEC` | `command`*、`cwd`、`timeoutMs` | 本机 shell。回执含 `exitCode`/`signal`/`timedOut`/`outputTruncated`/`stdout`/`stderr` |

\* 必填。每个工具的 description 内嵌完整参数、回执与风险说明（模型可直接读到）。

### ⚠️ 这组工具的风险定位（启用前务必读）

`local_*` 把**本机文件系统与 shell 暴露给一个云端模型会话**，且网页侧没有人在环的确认闸门。
提示注入（模型读到的任何外部内容都可能是载体——网页内容、文件内容、命令输出）可直接指挥它
读写文件、执行命令。与 `dsh_task_*` 的最坏情况（"派了个任务"——任务在 DSH 里可见、可 steer 可 cancel，但**派发本身不经确认卡**，只有 60s/10 次策略闸）不同，
这里的最坏情况是"仓库被改、命令被执行、文件被读走"。

因此实现内置了六层防护，**不是可选项**：

1. **默认关闭 + 两个独立开关**：不显式 opt-in 就一个工具都不注册。
2. **本链路凭据强制不可读写**：`~/.dsh/task-bridge-token`（或 `TASK_BRIDGE_TOKEN_FILE`
   指向的路径）与 `~/.dsh/.credentials.yaml` 一律拒绝，**且不可通过任何配置解除**——
   这条只约束 `local_*` **文件工具的路径参数**（含递归遍历中遇到的每个条目，0.5.1 起）。
   ⚠️ 一旦开了 `DSH_BRIDGE_LOCAL_EXEC=1`，同一条命令（`type` / `Get-Content` / `node -e` /
   `certutil -encode`）就能直接读出这些文件，第 ②③④⑤ 层保护对 exec **不成立**。这不是实现缺陷
   而是 shell 的固有性质：给了 shell 就没有文件级边界可言。所以「开 exec」的代价要按
   「交出本机全部读权限」来估，不要按「文件工具那套保护还在」来估。
   理由：读走它们等于凭据永久留在云端对话记录里，属自毁而非能力。拒绝时不回吐任何文件内容。
3. **默认凭据保护**（可用 `DSH_BRIDGE_FS_DENY_CREDENTIALS=0` 显式解除，解除时启动打强告警）。
   0.5.2 按安全评审逐条核对的结果补齐了漏项——原来那份清单是凭直觉列的，漏掉了多个
   **本机实测存在且当时可读**的位置。现在覆盖：
   - 目录树：`~/.ssh`、`~/.aws`、`~/.azure`、`~/.gnupg`、`~/.kube`、`~/.dsh`、
     `~/.codex`（`auth.json`）、`~/.claude`（`settings.json` 可含 env 秘密；`projects/` 下是
     **完整会话转写**）、`~/.openviking`（`ov.conf` 含模型端点与凭据配置）、`~/.docker`、
     `~/.terraform.d`、`~/.config/gh`（`hosts.yml` 里的 `oauth_token`）、`~/.config/gcloud`、
     `~/.config/rclone`、`~/.config/op`
   - 文件名：`.env`/`.env.*`、`id_rsa`/`id_ed25519` 类、`*.pem`/`*.p12`/`*.pfx`/`*.key`/`*.ppk`、
     `credentials.json|yaml`、无扩展名的 `credentials`、`credentials.db`/`credentials.tfrc.json`、
     `auth.json`、`secret(s).yaml|json`、`rclone.conf`、`.git-credentials`、
     `kubeconfig`/`netrc`/`pgpass`/`npmrc`/`pypirc`、
     shell 与 REPL 历史（`.bash_history`/`.zsh_history`/`.psql_history`/`.lesshst` 等——
     人手粘贴过的 token 会长期留在这里）、Chromium 系 `Login Data` 与 `Local State`

   刻意**没有**纳入的常见误伤项：`tokens.json`（设计系统的 design tokens）、`auth.spec.ts`、
   `credentials.yaml.example`、`state.json`。完整清单见 `src/local-fs.mjs` 的
   `PROTECTED_DIRS` / `PROTECTED_NAME_PATTERNS`，两者都有逐条测试钉子。
4. **白名单模式**（`DSH_BRIDGE_FS_ALLOW`，0.5.2）：设置后所有文件工具路径与 exec 的 cwd
   必须落在列出的根内，`..` 穿越、大小写/ADS/UNC 变形、junction 逃逸一律以 canonical
   结果判定；递归遍历内**逐条目**生效（不是只查搜索根）。与第 ②③ 层是 AND 关系——
   **只收窄、永不放宽**。⚠️ 管不住 `local_exec` 命令里的绝对路径。
5. **自身完整性保护**（0.5.2）：`local_write_file` 不得改写 bridge-mcp **自己的包目录**
   （含 append 与新建文件），也不得改写审计日志文件。生产 profile 直接
   `node <工作树>/src/server.mjs`，所以改写 `src/local-fs.mjs` 能永久静默移除全部防护、
   改写 `src/server.mjs` 能在下次启动时执行任意代码——那不是破坏，是**持久化**。
   读仍然放行（本包是公开仓库，源码不是秘密；挡读只妨碍正常使用）。
   包目录这项可用 `DSH_BRIDGE_FS_ALLOW_SELF_WRITE=1` 解除（启动打强告警）；
   **审计文件那项不可解除**——能被一次写调用截断清零的审计不构成控制。
   ⚠️ 作用域边界是**实测**得出的：exec 开着时 `echo > src/local-fs.mjs` 就绕过了它，
   所以这层真正防的是「只开 `LOCAL_FS` 不开 shell」那个更窄配置下的唯一改写通道。
6. **写与执行每次都写审计日志**：
   `AUDIT local_write_file path=… mode=… existed=… previousSize=… writtenBytes=…`、
   `AUDIT local_exec cwd=… timeoutMs=… exit=… timedOut=… command=…`。
   记路径与命令原文（都不是秘密），**绝不记文件内容与命令输出**（可能含敏感数据）。
   0.5.2 两处加固：① 自由文本字段改为 JSON-string 兼容的带引号转义，命令里的换行**不能
   再伪造额外审计行**（原来一次注入就能凭空造出或抹掉一条记录，而审计是这条链路宣称的
   唯一补偿性控制）；② 落盘与 logger 解耦——0.5.1 把落盘挂在默认 logger 上，注入 logger
   就会静默丢掉审计。stderr 在生产部署下不进 tunnel-client 日志，要留痕必须设
   `DSH_BRIDGE_AUDIT_FILE`（见上）。

此外还有两条**有界性**约束（0.5.2），防止单次调用把宿主拖死：`local_grep` 有整次调用的
墙上时间预算（`DSH_BRIDGE_GREP_TIMEOUT_MS`，默认 10s），`local_exec` 有并发上限
（`DSH_BRIDGE_EXEC_MAX_CONCURRENT`，默认 4，超限立即返回 `exec-busy` 而非静默排队）。

### 怎么设这些开关（三种部署形态各不相同，别照抄）

`mcp.commands[]` 只接受 `channel` 与 `command` 两个字段（实测探测 `env`/`environment`/`cwd`/`argv` 全被严格字段校验拒绝），而 `command` 串又**不经 shell**——所以 `set X=1 && node …` 这种写法不行，`&&` 不会被解释，整串会被当成可执行文件名而报 script not found。

- **Codex**：`~/.codex/config.toml` 的 `[mcp_servers.dsh-task-bridge]` 里加
  `env = { DSH_BRIDGE_LOCAL_FS = "1" }`，重启 Codex。
- **tunnel-client（ChatGPT 网页形态）**：profile 里没有 env 口子，唯一可行路径是设 **OS 用户级
  环境变量**再重启 tunnel-client（子进程继承它的环境）：

  ```powershell
  [Environment]::SetEnvironmentVariable('DSH_BRIDGE_LOCAL_FS','1','User')
  [Environment]::SetEnvironmentVariable('DSH_BRIDGE_AUDIT_FILE',"$env:USERPROFILE\.dsh\bridge-audit.log",'User')
  # 停掉现有 tunnel-client 进程，再从**新开的**终端拉起（旧终端读不到新设的用户级变量）
  Stop-Process -Name tunnel-client
  Start-Process 'E:\Program Files\tunnel-client\tunnel-client.exe' -ArgumentList 'run','--config','<profile 路径>'
  ```

  生效证据：tunnel-client 日志（或该进程 stderr）里出现 `[bridge-mcp] local tools ENABLED: …`
  横幅。**但审计行不会进 tunnel-client 的日志文件**（见上方 `DSH_BRIDGE_AUDIT_FILE` 的警告），
  所以务必同时设审计落盘路径，否则事后无从追溯。
  生效后要在 ChatGPT **新开对话**——云端只在握手时拉工具清单。
- **手工 node**：`$env:DSH_BRIDGE_LOCAL_FS='1'; node src/server.mjs`（仅当前终端会话）。

启用建议：

- 只开 `LOCAL_FS`、不开 `LOCAL_EXEC`，先用 `local_read_file`/`local_grep` 满足"网页侧查代码"
  的绝大部分需求——这两者不需要 shell。
- 写操作只在 git 工作树内进行，写完立刻 `git diff` 复核。
- 用 `DSH_BRIDGE_FS_DENY` 把不想被碰的目录显式拉黑（按目录前缀匹配，子文件一并拒绝）。
- 要开 `LOCAL_EXEC` 就想清楚：`command` 经 shell 解释（Windows 上是 `cmd.exe`），
  `& | ^ < >` 等都是元字符、不做转义；破坏性命令（`rm`/`del`/`format`/`git push --force`/
  `git reset --hard`）模型被要求必须先向用户确认，但那是**纪律而非机械闸**。

### 有界性（避免一次调用拖死链路）

- 读取与 exec 输出共享 `DSH_BRIDGE_FS_MAX_BYTES`（默认 256KB）；exec 输出超限即杀进程树并置
  `outputTruncated`。
- `local_exec` 超时由模块内定时器实现，到点用 `taskkill /T /F`（Windows）/ `kill -9 -<pgid>`
  （POSIX）**终止整棵进程树**。不能只靠 `child.kill()`：`shell:true` 下直接子进程是 shell，
  杀了它孙进程仍持有 stdout 管道，`close` 事件永不触发（实测 500ms 超时变成等满脚本的 30s）。
  收口时显式 `destroy()` 两条 stdio 流，否则宿主进程会悬挂到子进程自然退出——常驻 server 上
  这就是句柄泄漏。
- 另监听 `exit` 作为兜底（250ms 缓冲让已收数据落地）：宁可少几个尾字节，也不能让工具调用永久
  挂起（那会撞穿 MCP `tool_timeout_sec`，表现成"整个会话卡死"）。
- `local_grep` 有四重上界：**文件数**（`DSH_BRIDGE_GREP_MAX_FILES`）、**命中数**（`limit`，clamp 到 5000）超限会置 `truncated` / `limitTruncated`；**深度**（`DSH_BRIDGE_GREP_MAX_DEPTH`，默认 12）到顶置 `depthLimited`（0.5.0 是静默停止下潜，`truncated:false` 会被读成「整棵树搜全了」）；**整次墙上时间**（`DSH_BRIDGE_GREP_TIMEOUT_MS`，默认 10000，0.5.2 新增）到点即停，并按原因分别置 `regexTimedOut`（正则灾难性回溯被 `vm` 强制中断）与 `wallTimedOut`（树太大/磁盘太慢），回执另带 `elapsedMs` / `regexMs` / `skipped.regexTimeout`。两种超时刻意分开报：前者要改写 pattern，后者要收窄 path，混成一个标志会让调用方修错方向。
- `local_exec` 有并发上限（`DSH_BRIDGE_EXEC_MAX_CONCURRENT`，默认 4，0.5.2 新增）：超限**立即**返回 `code=exec-busy` 而不是静默排队——排队会让调用方以为命令在跑，而队列本身又是新的无界资源。额度在 `close`/`exit`/超时/输出超限各条路径上都恰好归还一次（有专门用例钉住，重复归还会让计数变负、闸门失效）。
- 被跳过的文件逐项计数并如实上报：`skipped.{oversize,binary,protected,unreadable}`，且**只要有跳过就置 `truncated=true`** 并给出 `note`——0.5.0 把超限/二进制文件静默 `continue` 却仍计入 `filesScanned`，于是「扫了 N 个、只有 1 处命中、没截断」无法区分"确实没有"与"被跳过了"。`local_list_dir` 同理报 `skippedProtected` / `depthLimited`。
- 单文件模式（`path` 指向文件）与目录模式共用同一套 size / 二进制闸门（0.5.0 的单文件分支两者都没有：实测 `maxBytes=1024` 时仍把 200MB 文件整体读入堆，rss +392MB）。

### 已知未修（0.5.2 如实披露，别按"已加固"来估风险）

0.5.1 这一节列的四条，三条已在 0.5.2 修掉（ReDoS、凭据清单漏项、可改写自身源码），
第四条（POSIX 进程组终止）从「未测死代码」升级为「分支已测、内核语义仍未验证」。
以下是**修完之后仍然成立**的残余风险，按重要性排列：

- **开了 `local_exec`，所有文件级边界归零**。凭据保护、白名单、自身完整性保护全都是
  **文件工具层**的约束，而 shell 不受它们管：`type C:\Users\you\.ssh\id_rsa`、
  `echo x > <工作树>\src\local-fs.mjs`、`curl` 外传，一条命令就够。这不是实现缺陷而是
  「给出 shell」的定义本身。所以启用梯度只有一条正确读法：**`LOCAL_FS` 单独开 = 有边界；
  `LOCAL_EXEC` 一开 = 没有边界**。别把六层防护当成开了 exec 之后还在生效。
- **`local_grep` 是「有界阻塞」，不是「不阻塞」，而且取消仍是 no-op**。0.5.2 把正则执行放进
  `vm.runInContext(…, { timeout })`，实测能中断灾难性回溯（`(a+)+$` 对 33 字符输入：原生跑过
  15000ms 需外部 `taskkill` → 现在 418ms 中断并如实置 `regexTimedOut`），中断后事件循环恢复、
  同实例后续调用正常。但 `grep()` 整体是同步的，**预算期内事件循环仍然是停的**：默认 10s
  已接近常见 MCP `tool_timeout_sec`，调大前请确认客户端超时。另外 `notifications/cancelled`
  的 abort signal 只透传给桥的 fetch，本地工具 handler 忽略 `_client`——**取消对本地工具依然
  无效**，它只会跑到自己的预算为止。本版没有做 AbortSignal 贯穿。
- **`vm` 的中断行为只在 Node v24.13.1 上实测过**。`engines` 声明 `>=18.17`，而「timeout 能
  中断 irregexp 回溯」依赖 V8 的中断检查点，我没有 18/20/22 的环境去测。若在旧版本上退化成
  「不能中断」，表现就是回到 0.5.1 的冻结行为——**不会更糟，但保护会静默失效**。
  换 Node 大版本后建议重跑一次 `local_grep` 的灾难性 pattern 用例。
- **默认凭据保护仍然是黑名单，本质上列不全**。0.5.2 补的是安全评审逐个实测到的漏项，
  不等于穷举：小众工具的凭据位置、项目内自定义的秘密文件、非标准路径一律不在清单里。
  要真正的收窄请用 `DSH_BRIDGE_FS_ALLOW` 白名单（只放行指定根），而不是继续往黑名单上加项。
- **审计文件自己会变成秘密存储**。审计行记的是**命令原文**（这是设计：命令不是秘密，
  输出才是）。但现实里命令经常内联秘密——`curl -H "Authorization: Bearer xxx"`、
  `mysql -pPASSWORD`、`git clone https://user:token@…`。这些会**逐字落进审计文件**。
  所以 `DSH_BRIDGE_AUDIT_FILE` 要按凭据来管：放在只有本用户可读的位置，别提交进仓库、
  别塞进会被 `local_grep` 扫到的项目目录。这一条 0.5.1 就该写，当时漏了。
- **POSIX 的进程组终止：内核语义未验证**。本机无 Linux/macOS，且 `wsl.exe -l -v` 返回
  「没有已安装的分发版」，所以**无法实测**。0.5.2 把 `platform` 与信号发送函数做成可注入，
  于是这条分支的**代码路径**有了单测覆盖（断言 `detached:true`、对 `-pid` 发 `SIGKILL`、
  兜底 kill 仍执行、不去 spawn `taskkill`），把「未测死代码」降级为「分支已测」。
  但「Linux 内核确实会因此杀掉整棵进程树」这一步仍标 **未验证**。Windows 的
  `taskkill /T /F` 已实测有效（孙进程存活 5800ms → 600ms）。
- **symlink 逃逸只实测了 Windows junction**。白名单与递归保护对 junction 的逃逸已实测拦住；
  POSIX 的 symlink 只有代码路径推理支撑（`canonical` 走 `realpathSync.native`，语义上应一致），
  标 **未验证**。
- **`local_write_file` 没有并发/速率闸**。0.5.2 给 `local_exec` 加了并发上限，写文件没有——
  一次扇出几百个写调用不会被拦。危害小于 exec（写有审计、有路径保护），但仍是无界资源。

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
- **本地工具的凭据自保护**：启用 `local_*` 后，桥自己的 token 文件与宿主
  `.credentials.yaml` 仍**强制不可读写**（不可配置解除）——否则网页会话能把凭据读进云端
  对话记录。默认另保护 `~/.ssh`、`.env`、私钥类路径；详见「本地文件与命令工具」节。
- **本地工具的审计留痕**：`local_write_file` 与 `local_exec` 每次调用都写 stderr 审计行
  （路径 / 命令原文 / 退出码），不含文件内容与命令输出。经 tunnel-client 部署时这些行会落进
  它的日志文件，事后可追溯网页侧动过什么。

## 开发与测试

```powershell
npm run check   # node --check 全部源文件
npm test        # 离线回归 122 例（桥 7 工具 smoke 10 / 本地工具 71 / monitor 10 / workflow 20 /
                #   skills-package 3 / improvements 7 + CLI smoke），mock REST server，不依赖真桥
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

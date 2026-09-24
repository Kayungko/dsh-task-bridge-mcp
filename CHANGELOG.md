# Changelog

## [0.5.0] - 2026-09-24

### 新增：本地文件与命令工具（`local_*`，默认关闭）

动机：`dsh_task_*` 是任务编排——重活由 DSH 会话里的 agent 干，消耗 DSH 侧模型额度、秒级到分钟级、只能拿到尾部摘要（默认 6 条消息）。网页侧「查个代码、读个配置」这类需求走这条路既慢又贵。本版补上另一条路：`local_*` 工具**直接操作本机**，不经 DSH 任务会话，因此零模型额度、毫秒级、返回文件原文。两种模式并存，由调用方按需选择（对齐 WebCodex 同类能力面）。

- 新增 `src/local-fs.mjs`（纯模块，零依赖，fs 与 spawn 均可注入以便离线单测）与 5 个工具：`local_read_file`（带行号 `cat -n` 风格 + `offset`/`limit` 分页）、`local_write_file`（overwrite/append，父目录递归创建，回执含 `existed`/`previousSize`/`newSize`）、`local_list_dir`（可递归、跳过隐藏目录、无权限子目录静默跳过）、`local_grep`（JS 正则，跳过 `node_modules`/`.git`/`dist`/`build`/`coverage` 与二进制/超限大文件）、`local_exec`（本机 shell）。全部带 input/outputSchema。
- **env 双独立门控，默认全关**：`DSH_BRIDGE_LOCAL_FS=1` 开文件四件套，`DSH_BRIDGE_LOCAL_EXEC=1` 另开 shell。只认字面 `'1'`（`'true'`/`'yes'` 不算启用）。都不设时 `tools/list` 仍是原 7 个、`initialize` 的 instructions 不提本地工具、stderr 无横幅——既有链路逐字节零变化。env 只在进程启动时读一次，不支持热切换（能力面在进程生命周期内固定，避免"跑着跑着多出个 shell 工具"）。
- `instructions` 按启用集合动态拼接：只开文件时不提 `local_exec`，避免诱导模型调用未注册的工具。
- 启用时 stderr 打横幅，把实际生效的能力面与上限写进 tunnel-client 日志（运维可见性）。
- **四层内置防护**（不是可选项）：① 默认关闭 + 双独立开关；② 本链路凭据（`~/.dsh/task-bridge-token` 或 `TASK_BRIDGE_TOKEN_FILE` 指向的路径、`~/.dsh/.credentials.yaml`）**强制不可读写且不可配置解除**——读走等于凭据永久留在云端对话记录里，属自毁而非能力；拒绝时不回吐任何文件内容；③ 默认凭据保护（`~/.ssh`/`~/.aws`/`~/.azure`/`~/.gnupg`/`~/.kube` 整棵树 + `.env`/`.env.*`/私钥/`*.pem`/`credentials.*`/`kubeconfig`/`netrc`/`pgpass`/`npmrc`/`pypirc` 类文件名），可用 `DSH_BRIDGE_FS_DENY_CREDENTIALS=0` 显式解除、解除时启动打强告警；④ 写与执行每次都写 stderr 审计行（路径 / 命令原文 / 退出码），**绝不记文件内容与命令输出**。另有 `DSH_BRIDGE_FS_DENY` 追加黑名单（按目录前缀匹配）。
- 有界性：读取与 exec 输出共享 `DSH_BRIDGE_FS_MAX_BYTES`（默认 256KB，与桥 body 上限同量级）；`local_grep` 有文件数（2000）与深度（12）上限，超限置 `truncated` 如实报告不静默截断；二进制文件（前 8KB 内含 NUL）拒绝返回内容并指向 `local_exec`；大文件读取拒绝并提示分页。
- 风险在工具 description 里对模型明说（写操作无人在环、`local_exec` 是风险最高的工具、破坏性命令须先确认、优先用 read/grep 而非 cat/findstr），因为网页侧没有 DSH 那层确认闸门。

### 修复：`local_exec` 超时杀不掉进程树（Windows）

实测发现 `spawn` 的 `timeout` 选项与单纯 `child.kill()` 在 Windows + `shell:true` 下都不可靠：直接子进程是 shell（`cmd.exe`），真正的命令是它的孙进程，杀了 shell 孙进程照跑，`close` 事件要等孙进程 stdio 全关才触发——**500ms 的超时实测等满脚本的 30s**，超时期望完全落空，生产上会撞穿 MCP `tool_timeout_sec`（表现成"整个会话卡死"）。

- 改为模块内 `setTimeout` + `taskkill /pid <pid> /T /F`（Windows，走参数数组而非命令串以免多一层 shell 二次解析）/ `kill -9 -<pgid>`（POSIX）终止整棵进程树；实测 781ms 内收口，taskkill 报告杀掉 shell + 2 个孙进程。
- 另监听 `exit` 作为兜底（250ms 缓冲让已收数据落地）：宁可少几个尾字节，也不能让工具调用永久挂起。
- `timedOut` 改用显式标志判定，不再依赖 `signal === 'SIGTERM'|'SIGKILL'`（Windows 上被 `taskkill /F` 杀时退出码与信号都不可靠）。

### 修复：exec 收口后 stdio 句柄泄漏

被 taskkill 终止的进程树仍留有管道句柄，不显式释放则持有者（本进程）的 event loop 要等到句柄自然关闭。实测 500ms 超时 + 30s 脚本时，宿主进程多活满 30s；测试 runner 的 `duration_ms` 从 1135ms 的实际测试耗时虚高到 30350ms。**常驻 server 上这就是每次 exec 超时泄漏一个句柄**。修法：收口时 `destroy()` 两条 stdio 流（幂等，已关闭时抛错被吞掉）。修复后同一场景 842ms 收口，全套测试 `duration_ms` 30430ms → 2064ms。

### 验证

- 离线单测：新增 `test/local-fs.test.mjs` 48 例（门控组合、五个工具正常路径、三级凭据保护与解除、NUL 拒绝、黑名单、大小上限、二进制拒绝、分页、grep 跳过规则、审计日志内容与脱敏、超时/退出码/输出超限/cwd、server 层分发与 `LocalToolError` → `isError:true` 的 code 透传），含 3 个专钉上述两个 bug 的回归用例（stdio 必须 destroy、exit 必须能兜底收口、不得再依赖 spawn 的 timeout 选项）。全套 **102/102** 全绿（原 51 + 新 51）。
- **真机活体端到端**：真 spawn `node src/server.mjs` 走真 stdio JSON-RPC，四场景 32 项断言全过——A 默认关闭（7 工具、无 `local_*`、instructions 不提、stderr 无横幅）；B 只开文件（11 工具、无 `local_exec`、调它回 `-32602`、真读文件与真 grep 命中）；C 全开（12 工具、token 文件被拒且不回吐内容、write→read 往返、`local_exec` 真跑通 `6*7=42`、非零退出码如实报 `exit=4`、**桥侧 `dsh_task_capabilities` 仍打通 43120 且 7 条路由齐全**）；D 解除默认保护（`.env` 可读 + 启动强告警 + 桥 token 仍强制不可读）。

### 部署文档修正（分发友好性）+ 包元数据补齐

- README 安装节去掉作者开发机绝对路径（`D:\git\DHS-Tool\bridge-mcp`），改真实 clone URL + `<bridge-mcp>` 占位；其余同类路径（Codex `config.toml` 的 `args`、`dshq` 函数、`--cwd` 示例、「已知限制」里的桥端引用）一并中性化。
- 运行要求修正为与 0.27.0 合并后的事实一致：宿主侧桥内置于 `dsh-plugin-task-coordinator`，开关在「设置 → 任务编排 → 外部任务桥 → 启用外部桥」——原文仍写「dsh-plugin-task-bridge 已启用」，与本文件自己的头部注记矛盾，会让用户去找一个已不存在的插件。
- 新增「让 profile 里不出现仓库绝对路径」节：`npm i -g` 后 profile 可只写 `dsh-task-bridge-mcp`（PATH shim 按自身目录相对解析），消除仓库搬家导致的 profile 失效；并记录 `npx -y dsh-task-bridge-mcp` 当前不可用（registry 404）与其冷启动/离线隐患。
- 新增「路径写法注意」：Windows 路径必须用正斜杠或套 YAML 单引号——反斜杠在引号外与 YAML 双引号内都被当转义符吃掉（`D:\git\x` → `D:gitx`），而报错只说 script not found；不做 `${VAR}`/`%VAR%`/`~` 展开。实测于 tunnel-client v0.0.14。
- 兑现 0.4.1 声称但当时未落地的内容：拓扑图补 ChatGPT 网页 → Secure MCP Tunnel → tunnel-client → 本包一行；头部注记补指向 coordinator 仓 `docs/WEB-BRIDGE.md` 的网页部署 walkthrough 入口。
- 跨仓相对链接改绝对 URL 或标注「本仓不含」：`../bridge`、`../research/*` 在独立 clone 形态下全部 404（本仓 `git ls-tree` 无 `bridge/`、无 `research/`）。
- 工具清单标题「镜像桥 MVP 6 端点」改为「6 业务端点 + 1 只读能力查询 = 7 工具」，表格补 `dsh_task_capabilities` 行；回执字段按活体 `/v1/capabilities` 实测填写（`ok`/`protocolVersion`/`bridgeVersion`/`coordinatorVersion`/`coordinatorEnabled`/`capabilities`/`endpoints[]`/`limits`/`reportBack`/`cwdDefault`）。
- 「已知限制」按 2026-09-23 实测结果重新标注：第 1 条（未与真桥实机联调）已推翻；第 2 条**部分**推翻——tunnel-client stdio 链路已端到端验证，但 Codex CLI 自身 `config.toml` 形态本轮未重新取证，措辞如实区分。第 3 条（无 `dsh_task_cancel`）仍成立。
- 包元数据补齐以备发布：新增 `LICENSE`（MIT，与 `package.json` 声明对齐——此前声明 MIT 但仓库无该文件）与 `repository` 字段。`bin` 与 `src/server.mjs` 的 shebang 经核实齐备；npm 发包仍阻塞于本机未登录（`ENEEDAUTH`）。
- 环境变量表补 9 个 `DSH_BRIDGE_*` 变量；安全注意事项补本地工具的凭据自保护与审计留痕两条。
- 桥侧 wire 契约零改动：7 条 `/v1/*` 路由、`X-Task-Bridge-Token`、token 路径、信封形状全部冻结未动，本地工具不经桥。

## [0.4.1] - 2026-09-23

### outputSchema 全覆盖 + 重定向到合并后桥

- 七个 dsh_task_* 工具全部补 outputSchema（云端工具面板与模型侧可据 schema 理解返回结构；inputSchema 原有不动）。stdio/cli 双传输自洽验证 51/51 全绿。
- DSH 侧重定向说明：服务端现为 dsh-plugin-task-coordinator ≥0.27.0——独立包 dsh-plugin-task-bridge 已合并内置并标 DEPRECATED（其仓 0.3.1）。wire 契约冻结未变，本包代码零协议改动；README 补 DEPRECATED 指向与合并后拓扑（ChatGPT 网页 → OpenAI Secure MCP Tunnel → 本包 → 合并后桥）。实测合并硬切换时本包零改动存活、tunnel-client 无需重启。
- 发版：git tag v0.4.1（tag 为唯一发布号；package.json = MCP serverInfo = CLI banner 已随 0.4.1 对齐）。

## [0.4.0] - 2026-09-18

### 收编正式化（0918 总控）

- 收编 09-12 Codex 协作波次已提交两件（0ff3346 统一桥传输+可靠 Codex 反馈 / 892e7d4 本地静默监控器）与**未提交半成品**（workflow v1 控制面 + dsh-orchestration skill 统一入口 + 离线技能打包器，脏树 7 改 11 增）。收编时自洽验证：cli smoke 33/33 + workflow 20/20 + skills-package 3/3 全绿。workflow v1 标注为**本地 CLI 控制面首版**（不自动迁移旧 monitor/任务，不启动自动化）。
- 版本轨道收敛（评审 P2-1）：自本版起 **git tag 为唯一发布号**，package.json（=MCP serverInfo=打包 manifest）与 CLI banner（运行时读 package.json）随 tag 对齐；历史 tag v0.2.0/v0.3.0 为内部发布点（CLI 工具包波次/传输统一+监控器波次），变更明细见提交历史，不回填 CHANGELOG 节。
- **managed 策略纪律闸接受记录（评审 P2-3，总控 0918 显式接受）**：workflow managed 策略可在 policy 范围内自动向 DSH send（无逐项人工确认；全链无 spawn 路径），authorizationRef 为 controller 自填文本、代码不可验证人类授权真实性——属纪律闸而非机械闸（workflow-v1.md 已披露）。总控显式接受该残余风险：本地信任模型、严格窄于既有 dshq send 直通能力（加闸非开闸）；approver 身份字段增强列 backlog。

### Codex 协作增量（09-12 波次原文）

编排 Skill 入口纳入源码，按需加载单步操作、监控、工作流和协议参考。新增自带运行代码的离线技能打包器与可移植性回归，生成待部署产物而不安装。修正 steer 入队与实际消费的区分，以及串行派发请求不等于等待所有任务依次完成的说明。

新增通用 workflow v1：事项/会话/通知分离，observe/assist/managed 策略、版本与租约检查、复审往返、转交、对账和只读 DSH 采集；新增独立契约、CLI 和多场景回归。旧 monitor 与运行配置不自动迁移。

新增本地静默监控器：按 owner 隔离、游标续读、反馈去重、合并摘要、显式 ack、运行租约和有界停止；无模型调用或自动唤醒。共享状态文件原子替换增加有界瞬时错误重试。

CLI/MCP 共用回环传输、全响应超时与脱敏；MCP 请求取消、externalRef、只读标记与结构化结果；运行能力查询和增量 progress；新增回归与随包使用文档。

仅源码变更，不表示已部署、重启或完成实机验收。

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-09-10

互操作修正：对齐桥端 dsh-plugin-task-bridge v0.1.0 已落地的实现
（权威端点对照表与错误码表见 `D:\git\DHS-Tool\bridge\README.md`）。

### 修正

- **send wire 字段**：桥端 `/v1/send` 正文字段为 `text`；工具面参数名保持
  `message`（对 Codex 语义更自然），`src/tools.mjs` 组包时映射为 `text`。
- **策略闸语义**：滚动窗口 60s/10 次（可配），超限返回 429 `policy-gated`
  （附 `retryAfterMs`）——修正 v0.1.0 误写的「>2 次/confirmation-required」；
  处置纪律改为「读 retryAfterMs 等待后重试，串行派发天然低触发」。
  同步 `instructions`、README、SKILL.md 三处。
- **错误码表对齐桥端八值稳定枚举**：`unauthorized`(401/403) /
  `forbidden-body`(400/413/415) / `bad-request`(400/405) / `policy-gated`(429) /
  `rate-limited`(429) / `queue-full`(429) / `not-found`(404) /
  `upstream-error`(500/502/503)；上游 ops 码经 `upstreamCode` 透传
  （如 `model-select-failed`/`kickoff-rejected`，孤儿 `sessionId` 一并透传）。
  SKILL.md 桥层处置表整表重写。
- **progress 回执字段对齐**：无 `live` 字段；`agentState` 为三值枚举
  （idle/running/cold-idle），补 `updatedAt`/`inspectError`。
- **spawn/send/wait 工具 description**：失败 code 改为桥端枚举表述；
  send 回执补 `delivered`/`targetId`/`mode`；wait 回执补 `reason`/`count`
  与 targets 元素形状；list 的 `limit` 补 1..500 范围。

### 测试

- smoke 断言同步：send 请求体 `text` 字段（且无 `message`）、progress mock
  回执桥形状（agentState 三值）、spawn 失败 mock 桥信封
  （code=`upstream-error`+`upstreamCode`+孤儿 sessionId 透传）、
  instructions 关键词 `policy-gated`/`retryAfterMs`。

## [0.1.0] - 2026-09-10

首个版本：Codex 侧 MCP stdio wrapper，把 dsh-plugin-task-bridge 的 REST 端点
包装成 Codex 可调用的 MCP 工具。

### 新增

- MCP stdio server（`src/server.mjs`）：手写 JSON-RPC 2.0 循环，零运行时依赖；
  支持 `initialize`（含 `instructions` 拉模型纪律）/ `tools/list` / `tools/call` /
  `ping`，忽略通知类消息，未知方法回 `-32601`；stdin EOF 优雅退出——等待在途
  tools/call（异步 fetch）落定并写出响应后才退出，不丢响应（附 70s 安全网）。
- REST client 层（`src/client.mjs`）：
  - base URL 默认 `http://127.0.0.1:43120`，env `TASK_BRIDGE_URL` 覆盖；
  - 鉴权头 `X-Task-Bridge-Token`：env `TASK_BRIDGE_TOKEN` 优先，缺省读
    `~/.dsh/task-bridge-token`（env `TASK_BRIDGE_TOKEN_FILE` 可覆盖路径），
    每次请求惰性解析；token 缺失时报可操作的清晰错误；
  - fetch 超时（AbortController）与错误映射：`bridge-unreachable` /
    `bridge-timeout` / `bridge-http-error` / `bridge-invalid-response`；
  - 应答信封 `{ok:true,...}` / `{ok:false,code,error}`：`ok:false` 无论
    HTTP 状态码一律转 MCP tool error（code+error 透传，绝不吞错），信封附加
    字段（如 `rate-limited` 的 `retryAfterMs`、spawn 失败的孤儿 `sessionId`）
    一并透传。
- 工具集（`src/tools.mjs`，镜像桥 MVP 6 端点；cancel 属桥第二批，暂不提供）：
  - `dsh_task_spawn`（POST /v1/spawn；回执含 workspace/placement/modelSource；
    reportBack 结构性关闭——不暴露该参数）；
  - `dsh_task_send`（POST /v1/send；回执含 messageId/queueDepth/placement）；
  - `dsh_task_progress`（GET /v1/progress）；
  - `dsh_task_wait`（GET /v1/wait；timeoutMs 钳制 ≤50s，默认 45s；
    `settled:false` 属正常心跳语义，非错误）；
  - `dsh_task_list`（GET /v1/list）；
  - `dsh_task_models`（GET /v1/models）。
- 离线 smoke 测试（`test/smoke.mjs`）：node:http 起临时 mock REST server，
  覆盖全工具打通、ok:false 转 MCP error、token 缺失报错、wait 钳制、
  超时与不可达处理、JSON-RPC 协议分支；不依赖真桥，token 全部为合成假值。
- 文档：README.md（安装 / `~/.codex/config.toml` 配置片段 / 工具用法 /
  安全注意事项）、skills/dsh-task-bridge/SKILL.md（拉模型纪律 / 策略闸 /
  回执字段解读 / 错误码处置表）。

### 已知限制

- REST 端点形状按 research/task-bridge-reanchoring.md §0.2/§3 蓝图与桥插件
  共用契约设计；与真桥（D:\git\DHS-Tool\bridge，并行开发中）的实机联调
  留待总控 bring-up 阶段。
- Codex 实机 MCP 挂载（config.toml 字段生效行为、instructions 采用度）未验证。

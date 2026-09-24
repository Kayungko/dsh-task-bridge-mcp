# Changelog

## [0.5.1] - 2026-09-24

### 安全修复：0.5.0 的凭据保护可被两条独立路径完全绕过

四路并行评审（安全攻击 / 正确性含变异测试 / 文档一致性 / 契约兼容）后，安全与正确性两路各自独立判定 **不通过**。所有 P0/P1 均由评审给出 PoC、并由维护者用独立脚本复现确认后修复。

**P0-A 递归遍历完全绕过三层路径保护**（正确性评审发现，安全评审未覆盖此路径）：`guardPath` 只作用于搜索/列举的**根**，`walk` 内对发现的每个文件从不检查。于是**一次** `local_grep(path=父目录)` 就能读出 `~/.dsh/task-bridge-token`、`.credentials.yaml`、`.env`、`*.pem` 的**原文**——正是模块头注释自己定义的最坏情况。更糟的是 README 推荐的「只开 `LOCAL_FS` 不开 shell」这个"更安全"配置恰恰是绕过生效的配置，且 51 个用例里**零覆盖**（所有凭据保护断言都只走 readFile/writeFile）。
修复：新增 `guardWalkEntry`（不抛错、返回 null 即跳过），`grep` 与 `listDir` 的 walk 对**每个文件与每个待递归目录**都过一遍三级保护；跳过数如实计入 `skipped.protected` 并置 `truncated`。`PROTECTED_DIRS` 补 `.dsh`（整棵树），使「把 `~/.dsh` 当搜索根」在根上就被拒。

**P0-B 路径变形击穿强制保护，读写双向**（安全评审发现）：`guardPath` 用 `resolve()`（纯字符串规范化）+ 精确字符串比较，四条独立通道全部绕过——大小写变形（`TASK-BRIDGE-TOKEN`、`c:\users\…`）、NTFS 备用数据流（`token::$DATA`）、UNC 前缀（`\\?\`、`\\.\`）、symlink/junction。写方向同样穿透，意味着可把桥 token 覆写成攻击者已知值、直接劫持整条链路鉴权。
修复：新增 `canonical()`（剥 `::` 流名 → `realpathSync.native` 解析真实路径 → 在不区分大小写的平台 lowercase），三级保护**两侧**都用 canonical 比较；强制保护补「候选落在保护项子树内」匹配。另加 `displayPath()` 专供回执——canonical 的小写形式不能直接返回给用户（初版犯过这个错，回执与审计行里路径全变小写），displayPath 保留 OS 正确大小写，且对尚不存在的路径逐级上溯到最近的存在祖先再拼回。

**P0-C `local_exec` 全量继承 `process.env`**（安全与正确性评审各自独立实测）：`env: { ...process.env }` 使一条 `local_exec{command:'node -e "console.log(process.env.TASK_BRIDGE_TOKEN)"'}` 就把桥 token 送进云端对话记录——而 `TASK_BRIDGE_TOKEN` 是 README 明确支持、优先级最高的注入方式；本机还实测存在 `MANA_API_KEY`、`MOONTONTECH_API_KEY` 等用户级秘密。这不是 exec 的固有风险而是纯代码选择。
修复：改为 `buildExecEnv()` 白名单（PATH/SystemRoot/ComSpec/PATHEXT/TEMP/USERPROFILE/APPDATA 等命令必需项）+ 双重强制剔除（`TASK_BRIDGE_*`/`DSH_BRIDGE_*`/`DSH_READBACK_*` 前缀，以及名字命中 `API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PRIVATE_KEY|ACCESS_KEY` 模式的键）。

**P1-A `treeKill` 的 spawn 未挂 error 监听 → 整个 MCP server 崩溃**：`try/catch` 只能捕获同步抛出，而 spawn 失败是异步 `'error'` 事件 → EventEmitter 未捕获异常。实测 taskkill 不在 PATH 时 `exit=9 UNCAUGHT:spawn taskkill ENOENT`，**连带 7 个桥工具一起不可用**——直接推翻 0.5.0 commit message 的「cannot affect existing consumers」。修复：挂 `error` 监听 + `resume()` 掉 stdio；POSIX 侧改用 `process.kill(-pid)` 消除对外部 `/bin/kill` 的依赖。

**P1-B 树杀实际失效，回执却声称已杀树**：`treeKill` 先异步 spawn taskkill、紧接着**同步** `child.kill('SIGKILL')` 把 shell 杀掉，等 taskkill 去查 PID 时进程已不存在——实测 `taskkill exit=128「没有找到进程」`，孙进程活到 5800ms（脚本寿命 6000ms，超时设 600ms），而 note 写着「已杀整棵进程树」。后果是破坏性命令超时后**继续跑**，且每次超时泄漏一个孤儿进程（评审在测试跑完 8s 后仍在进程表里抓到 PID 1224）。修复：改为 taskkill 的 `close` 回调里再兜底 kill（外加 2s 上界），并给 POSIX 分支加 `detached: true` 使 `child.pid` 真的成为 PGID。实测孙进程存活从 5800ms 降到 600ms。

**P1-C grep 单文件模式无 size / 二进制闸门**：该分支直接 `readFileSync(root)`，实测 `maxBytes=1024` 时仍把 200MB 文件整体读入堆（rss +392MB），含 NUL 的文件也照搜并把乱码灌进上下文；且 `filesScanned` 恒为 0、limit 触顶不置 `truncated`。修复：与目录模式共用 `scanFile`（同一套 stat/NUL/保护检查）。

**P1-D ReDoS 可冻结整个 server 且不可取消**（安全评审实测 `(a+)+b` 指数增长、事件循环 5ms 心跳归零）：`notifications/cancelled` 的 abort signal 只传给桥 fetch，本地工具 handler 忽略 `_client`，取消对其是 no-op。**本版未修**（需要 worker_threads 重构），已在 README 风险节如实披露并给出规避建议。

### 有界性与回执诚实度

- `DSH_BRIDGE_FS_MAX_BYTES` 改**字节**语义：0.5.0 用 `String.length`（UTF-16 码元）比较与裁剪，CJK 内容下实测突破上限约 3 倍（10 万汉字 = 100005 码元 / 300015 字节，上限 262144）。现按 `Buffer.byteLength` 计数、`sliceBytes` 按字节裁剪并回退到 UTF-8 字符边界；回执新增 `stdoutBytes`/`stderrBytes`。
- 输出超限后**停止累积**：0.5.0 只阻止再次 treeKill 却继续 `stdout += text`，峰值内存由「子进程被杀前能灌多快」决定（实测 300MB 洪水使 rss 90MB → 885MB）。
- `StringDecoder` 处理多字节字符跨 chunk 边界：0.5.0 直接 `chunk.toString('utf8')`，大输出必现乱码（实测 400KB 中文 10 个 U+FFFD、900KB 20 个）。
- `limit` 入参 clamp（listDir ≤5000、grep ≤5000）：0.5.0 无上限，实测 `limit=1e8` 时 grep 单文件回执 JSON 达 6.70MB、listDir 4008 条 / 476KB，与 maxBytes 完全脱钩。
- `readFile` 读回后**复检**字节数：0.5.0 只校验 `stat.size`，读一个正被追加的日志就能拿到超限内容（用 fs 注入 seam 实测 stat 报 100 而返回 5000002 字符）。
- grep 深度到顶置 `depthLimited`（0.5.0 静默停止下潜，`truncated:false` 被读成「搜全了」）；跳过文件逐项计数 `skipped.{oversize,binary,protected,unreadable}`，有跳过即置 `truncated` 并给 `note`。
- `writeFile` 审计行**前置于 statSync**：0.5.0 在「写已落盘但 stat 抛错」时审计 0 条、回执退化成 internal-error——文件被改了却无痕，违反「每次写都留审计」。现记 `writtenBytes`（无需 stat），stat 失败时如实返回 `statUnavailable: true` 而非谎报大小。
- `writeFile` 的 pre-write stat 抛非 ENOENT 错误时不再一律报 `existed=false`（0.5.0 会在 EACCES 下谎报「新建」并 previousSize=0，随后覆写真实文件）。
- 五个工具全部补 `annotations`（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`）：只写在 description 里是纪律不是防线，annotations 才是 MCP 客户端能据此加机械闸门的通道。
- `server.mjs` 模块级构造包 try/catch：本地工具初始化失败时降级为不注册 + stderr 强告警，**保住 7 个桥工具**（可选能力不该拖垮核心链路）。
- `buildLocalTools` 真正采用注入的 `config`（0.5.0 忽略 `deps.config` 自行重算，server 传的 `LOCAL_CONFIG` 是死参数）。
- `guardPath` 对 `op='exec'` 的拒绝文案不再说「拒绝写入」（0.5.0 三元只区分 read 与非 read）。
- 新增 `DSH_BRIDGE_AUDIT_FILE`：审计行落盘。安全评审实测生产 `tunnel-client.log`（3.9MB debug、两次启动）对 bridge-mcp 的 stderr **零命中**（profile 无 stderr 重定向字段），于是「写与执行都留审计」这条无人在环风险的唯一补偿性控制在主要部署形态下根本不落盘。

### 文档修正（评审 C 逐条核对 120+ 条事实性陈述后指出）

- **「模式 A 有人在环（DSH 确认闸门）」与实现相反**（P0，出现在 5 处）：桥 `/v1/spawn` 直调 `ops.spawnTask`，其签名无 `confirmationId`，确认门只在 `spawnBatch`；`bridge-policy.mjs` 的注释本身即写明「MVP 桥只用单发 spawnTask（无 coordinator 侧确认门——门只在 spawnBatch）」。已改为「任务在 DSH 侧可见、可 steer/cancel，但派发不经确认卡，只有 60s/10 次策略闸」。这是本轮两份文档做风险对比的核心论据，原文把风险说小了。
- **「凭据强制不可读写且不可配置解除」补 exec 例外**：该保护只约束文件工具的路径参数，开了 `LOCAL_EXEC` 后一条命令即可读出，第 ②③ 层对 exec 不成立。
- **「只开文件、不开 shell 是更稳的形态」不成立**：文件写权限本身足以达成代码执行与持久化（写 `src/server.mjs`——生产 profile 直接跑工作树、下次启动即执行；写 Windows 启动项、PowerShell profile、`~/.claude/settings.json` 的 hooks、`.git/hooks/*` 同理）。改为「更窄而非安全」。
- **补「怎么设这些开关」节**：0.5.0 的头号特性在 tunnel-client 形态下**没有任何文档化的启用路径**——profile 无 env 字段、`command` 串不经 shell（`set X=1 && node …` 会被当成可执行文件名而失败），而 9 个 `DSH_BRIDGE_*` 变量唯一被讲解的位置是 Codex `config.toml` 子节。现按三种部署形态分别给出可复制命令与生效证据。
- 审计「会落进 tunnel-client 日志」的声称按实测更正，并指向 `DSH_BRIDGE_AUDIT_FILE`。
- `local_grep`「不静默截断」按新语义重写（深度到顶置 `depthLimited`、跳过逐项计数）。
- 「逐字节零变化」改为准确表述：`tools/list`、`instructions`、错误信封与桥路径逐字节相同，`initialize` 仅 `serverInfo.version` 随版本轨道变化（契约评审用 0.4.1 与 0.5.0 双进程逐字节比对取证）。
- `client.mjs` 的 token 缺失错误文案不再指向已 DEPRECATED 的 `dsh-plugin-task-bridge`（它与 README「不要再去装它」直接冲突，会把用户推去装废弃包），改为指向 coordinator ≥0.27.2 自动生成或手工创建。
- CHANGELOG 0.5.0 的「48 例」更正为 51（与同句「原 51 + 新 51」自相矛盾）；README「10 个用例全绿」更正为 122 并给出分布。

### 验证

- 离线单测 **122/122** 全绿（0.5.0 的 102 + 新增 20 条 0.5.1 回归钉子，逐条对应上述缺陷：递归 guard、canonical 四类变形、写方向变形、`.dsh` 作根被拒、`buildExecEnv` 剔除、exec 不见 token、treeKill error 监听、taskkill 与 child.kill 的**先后顺序**、字节上限、单文件闸门、`depthLimited`、读回复检、审计落盘、stat 失败仍留审计、limit clamp、annotations、注入 config 生效、exec 文案）。
- 维护者独立复现脚本回归：安全 PoC 从「10 项指控成立」→ **0 项**；正确性 PoC 从「6 项核心指控」→ **0 项**（grep 不再泄、树杀 600ms 生效、server 不再崩溃）。
- 0.5.0 的既有修复经变异测试复核仍然成立（撤掉 `destroy()` → `duration_ms` 30300ms；三个防回归钉子撤掉修复后均失败）。
- **未修且已披露**：ReDoS（需 worker_threads 重构）、默认凭据保护清单仍漏 `~/.codex/auth.json`、`~/.config/gh/hosts.yml`、`.bash_history`、`~/.git-credentials`、`~/.docker/config.json` 等（安全评审逐个实测本机存在且可读）——建议用 `DSH_BRIDGE_FS_DENY` 自行收窄，或等后续版本的 `DSH_BRIDGE_FS_ALLOW` 白名单模式。

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

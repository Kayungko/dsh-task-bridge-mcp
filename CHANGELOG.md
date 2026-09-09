# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

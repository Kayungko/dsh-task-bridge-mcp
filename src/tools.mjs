import { normalizeExternalRef } from './contract.mjs';
// dsh-task-bridge-mcp —— MCP 工具定义与 handler
// 工具集镜像桥 MVP 6 端点（research/task-bridge-reanchoring.md §0.2/§3）：
//   spawn / send / progress / wait / list / models
// cancel 属桥第二批端点，本版本不提供。
// reportBack 结构性关闭（不暴露参数）：伪 caller 非真实会话，反馈一律
// progress/wait 拉取（蓝图 §1.3 连带语义 3）。

export const WAIT_MAX_MS = 50_000;   // 契约④：wait 单次 ≤50s（Codex tool_timeout_sec 默认 60s）
export const WAIT_DEFAULT_MS = 45_000; // 推荐值：留序列化余量（蓝图 §3.2）

/** 工具入参校验失败。server 层映射为 isError:true 的 MCP tool result。 */
export class ToolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolValidationError';
    this.code = 'invalid-params';
  }
}

function requireString(args, key) {
  const v = args?.[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolValidationError(`参数 ${key} 缺失或不是非空字符串`);
  }
  return v;
}

function optionalString(args, key) {
  const v = args?.[key];
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new ToolValidationError(`参数 ${key} 必须是字符串`);
  return v.trim() || undefined;
}

/** 归一化 wait 的目标列表：接受单字符串或字符串数组。 */
function normalizeSessionIds(args) {
  const raw = args?.sessionIds ?? args?.sessionId;
  const list = Array.isArray(raw) ? raw : [raw];
  const ids = list.filter((x) => typeof x === 'string' && x.trim());
  if (!ids.length) {
    throw new ToolValidationError('参数 sessionIds 缺失：需一个或多个目标会话 id');
  }
  return ids;
}

export const INSTRUCTIONS = [
  'DSH 外部编排：仅在用户授权范围内派发/发消息。先查 dsh_task_capabilities；模型 ID 从 dsh_task_models 获取。spawn 显式传 cwd、externalRef，串行派发。delivered≠消费，idle/settled≠验收完成；未知目标须报错。反馈采用拉模型：wait 分段等，settled:false 正常；progress 用 cursor 只读增量。写请求超时先对账，勿盲目重发。',
  '1) 派发用 dsh_task_spawn 串行进行——桥侧策略闸限制滚动 60s 窗口内最多 10 次 spawn，超限返回 429 policy-gated（附 retryAfterMs）：读 retryAfterMs 等待后再重试，串行派发天然低触发。spawn 回执必读 workspace/placement/modelSource：ungrouped/worktree 落位（含 warning）须先补救或确认接受；模型路线不符预期立即停止并纠正。',
  '2) 反馈一律拉取（reportBack 已结构性关闭）：用 dsh_task_wait 分段等待（timeoutMs 默认 45000、上限 50000；settled:false 是正常心跳而非错误，续 call 即可），配合 dsh_task_progress 读 recent 尾部/todos/goal/agentState 判断进展。禁止高频轮询轰炸：wait 长轮询本身就是等待，progress 仅在 wait 返回 settled 或需要决策时读取。',
  '3) 纠偏用 dsh_task_send：只有需要改变运行中目标下一步时用 mode=steer；普通补充或交接用 queue。投递位置不证明模型已消费。queueDepth 只表示待处理队列长度，不保证消费轮数；不要为改变队列位置重复发送同一消息。',
  '4) 工具返回 isError:true 时读 code 与 error 字段并按 skills/dsh-task-bridge/SKILL.md 错误码处置表行动。spawn 返回 upstream-error 且信封含孤儿 sessionId（upstreamCode 为 model-select-failed/kickoff-rejected）时该会话已存在：先核对模型路线和开场是否接收，再在授权内决定补发或交总控处置，不能重复 spawn。',
  '5) 派发前不确定模型路线就先调 dsh_task_models 查合法 provider/model id——绝不猜 id。',
  '6) 换会话后先恢复已确认的事项与完整目标 ID；身份或归属不明确时才用 dsh_task_list（可带 team 过滤）核对，不靠标题猜测。',
].join('\n');

export const TOOLS = [
  {
    name: 'dsh_task_spawn',
    description:
      '在 DSH Desktop 中创建新的顶层任务会话并投递 kickoff 指令（POST /v1/spawn）。' +
      '参数：prompt（必填，完整自包含的 kickoff 指令——目标会话看不到当前对话，须包含全部所需上下文）；' +
      'title（可选，"类型｜主题" 语义，如 "修复｜对账精度"，日期前缀自动添加）；' +
      'team（可选，编组名，同 team 任务可在 dsh_task_list 中过滤）；' +
      'cwd（可选，建议显式传入；缺省为桥配置 defaultCwd 或宿主用户目录，不继承 Codex 目录）；' +
      'provider/model/reasoningEffort（可选，模型路线；不确定合法 id 先调 dsh_task_models，绝不猜）。' +
      '注意：本工具结构性关闭 reportBack（无此参数），新任务不会主动回报——反馈靠 dsh_task_wait/dsh_task_progress 拉取。' +
      '成功回执字段：sessionId、shortId、title、team、cwd、workspace（{id,title} 或 null）、' +
      'placement（exact-match/caller-inherited/ancestor-normalized/ungrouped-worktree/ungrouped 五级，后两级带 warning 需处置）、' +
      'model 与 modelSource（explicit/plugin-default/host-default 三级来源）、started、correlationId、depth。' +
      '失败（isError:true）时 code 为桥端稳定枚举：upstream-error（502，upstreamCode=model-select-failed/kickoff-rejected 时' +
      '信封含已创建的孤儿 sessionId，可补救）、policy-gated（429，spawn 滚动窗口超限，附 retryAfterMs）、bad-request（400）；' +
      'error 字段透传桥端原文。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整自包含的 kickoff 指令（新会话不共享当前上下文）' },
        title: { type: 'string', description: '会话标题语义部分："类型｜主题"（如 "修复｜对账精度"）' },
        team: { type: 'string', description: '编组（workstream）名，供 list 过滤' },
        cwd: { type: 'string', description: '新任务工作目录，建议显式传入；不自动继承 Codex cwd' },
        externalRef: { type: 'string', description: '完整外部任务/波次标识，trim 后不超过 200 字符；缺少身份时勿猜测' },
        provider: { type: 'string', description: 'LLM provider id（先查 dsh_task_models）' },
        model: { type: 'string', description: 'model id（与 provider 一起提供）' },
        reasoningEffort: { type: 'string', description: '推理力度（如 low/medium/high，按 models 目录支持情况）' },
      },
      required: ['prompt'],
    },
    async handler(client, args) {
      const body = { prompt: requireString(args, 'prompt') };
      for (const key of ['title', 'team', 'cwd', 'provider', 'model', 'reasoningEffort']) {
        const v = optionalString(args, key);
        if (v !== undefined) body[key] = v;
      }
      try { const ref = normalizeExternalRef(args?.externalRef); if (ref !== undefined) body.externalRef = ref; }
      catch (error) { throw new ToolValidationError(error.message); }
      return client.request('POST', '/v1/spawn', { body });
    },
  },
  {
    name: 'dsh_task_send',
    description:
      '向既有任务会话投递消息（POST /v1/send）。参数：sessionId（必填，目标会话 id）；' +
      'message（必填，消息正文：纠偏指令、补充上下文或交接信息）；' +
      'mode（可选：queue=下一轮开始时投递（默认，目标运行中排队/空闲即开新轮）；steer=运行中目标在当前轮的可用步骤边界投递——用于停止/纠偏/冲突警告等需要立刻改变下一步的场景）；' +
      'reference（可选，引用早前回执的 messageId 或 spawn 的 correlationId，用于可追溯的纠偏链）。' +
      '成功回执字段：delivered（是否已投递）、targetId、mode（实际投递模式）、messageId（可被后续 send 的 reference 引用）、' +
      'queueDepth（{nextTurn,nextStep}，投递后口径含本条；仅表示队列长度，不保证具体消费轮数）、' +
      'placement（next-step=进入步骤间投递位置 / next-turn=进入下一轮队列；均不证明已执行）、targetStatus（running/idle）、' +
      'note（冷目标投递的注意事项，如有）。' +
      '失败 code 常见：rate-limited（429，附 retryAfterMs，等够时间再发；含上游 target-busy）、queue-full（429，队列已满先等消费）、' +
      'not-found（404，upstreamCode=target-not-found/target-vanished：id 错误或会话已结束）、bad-request（400）。' +
      '桥不自动重试——重试节奏由调用方掌握。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id（dsh_task_spawn/dsh_task_list 获得）' },
        message: { type: 'string', description: '消息正文（纠偏/补充/交接）' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue=下一轮（默认）；steer=运行中立即在下一生效步骤生效' },
        reference: { type: 'string', description: '引用的早前 messageId 或 correlationId' },
      },
      required: ['sessionId', 'message'],
    },
    async handler(client, args) {
      // wire 契约：桥端 /v1/send 的正文字段是 text（工具面参数名保持 message，
      // 语义对 Codex 更自然）；此处做工具面→wire 的映射。
      const body = {
        sessionId: requireString(args, 'sessionId'),
        text: requireString(args, 'message'),
      };
      const mode = optionalString(args, 'mode');
      if (mode) body.mode = mode;
      const reference = optionalString(args, 'reference');
      if (reference) body.reference = reference;
      return client.request('POST', '/v1/send', { body });
    },
  },
  {
    name: 'dsh_task_progress',
    description:
      '读取一个任务会话的当前进度快照（GET /v1/progress），不打扰目标。参数：sessionId（必填）。' +
      '回执字段：agentState（idle/running/cold-idle 三值枚举；cold-idle=冷会话——冷≠无待办，结果用 todos/goal 确认）、' +
      'updatedAt（快照时间）、queue（排队消息）、recent（最近消息尾部摘要，条数与字符数由桥配置限制）、todos（任务清单状态）、' +
      'goal（目标进度，如有）、seq（序列号，可用于判断是否有新事件）、inspectError（冷会话检查失败原因，如有）。' +
      '用于 spawn 后检查 kickoff 是否被消费、wait 空闲后确认收尾状态、以及决策前读取上下文。只读操作，可安全穿插。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id' },
        cursor: { type: 'string', description: '上次 feedback.nextCursor；仅增量读取，缺口见 feedback.coverage' },
        messageId: { type: 'string', description: '要对账的 send 回执 ID；consumption 仅区分 queued/observed/unknown，不代表工作完成' },
      },
      required: ['sessionId'],
    },
    async handler(client, args) {
      const sessionId = requireString(args, 'sessionId');
      return client.request('GET', '/v1/progress', { query: { sessionId, cursor: optionalString(args, 'cursor'), messageId: optionalString(args, 'messageId') } });
    },
  },
  {
    name: 'dsh_task_wait',
    description:
      '等待一个或多个任务会话空闲（当前轮结束），长轮询、拉模型核心（GET /v1/wait）。' +
      '参数：sessionIds（必填，一个 id 或 id 数组）；mode（可选：all=全部空闲才返回（默认）/ any=任一空闲即返回）；' +
      'timeoutMs（可选，默认 45000，硬上限 50000——超过会被钳制；受 Codex 工具超时 60s 约束，勿建议更大值）。' +
      '回执：settled=true 表示目标已空闲（冷目标返回 settled=true，冷≠无待办，用 dsh_task_progress 确认）；' +
      'settled=false 表示本轮等待超时但目标仍在运行——这是正常心跳语义而非错误，直接再次调用本工具继续等待；' +
      'waitedMs（实际等待毫秒）、count（目标数）、targets[]（各目标 {sessionId,idle,agentState}）、reason（说明文案）。' +
      '纪律：spawn 后用本工具分段等待而非轮询轰炸；wait 返回 settled 后再读 dsh_task_progress 获取结果。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionIds: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: '目标会话 id（单个或多个）',
        },
        mode: { type: 'string', enum: ['all', 'any'], description: 'all=全部空闲（默认）；any=任一空闲' },
        timeoutMs: { type: 'number', description: '单次等待毫秒数，默认 45000，上限 50000（超出自动钳制）' },
      },
      required: ['sessionIds'],
    },
    async handler(client, args) {
      const sessionIds = normalizeSessionIds(args);
      const mode = optionalString(args, 'mode');
      const requested = Number(args?.timeoutMs);
      const timeoutMs = Math.min(
        Number.isFinite(requested) && requested > 0 ? requested : WAIT_DEFAULT_MS,
        WAIT_MAX_MS,
      );
      return client.request('GET', '/v1/wait', {
        query: { sessionIds: sessionIds.join(','), mode, timeoutMs },
        timeoutMs: timeoutMs + 5_000, // 客户端 fetch 超时略宽于桥等待窗口，防误杀正常长轮询
      });
    },
  },
  {
    name: 'dsh_task_list',
    description:
      '列出协调可见的顶层任务会话（GET /v1/list），用于换会话后重建指挥上下文。' +
      '参数全部可选：filter（对 session id/标题/cwd 的不区分大小写子串过滤）；team（只列某编组）；' +
      'includeSubagents（默认 false，true 时含子代理来源会话）；ungrouped（默认 false，true 时只列未入工作区组的会话，配合落位审计）；' +
      'limit（1..500，默认 50，最新在前）。' +
      '回执：tasks[]（每行含 sessionId/标题/运行状态/todo 与 goal 进度摘要等投影字段）与 truncated（结果被截断标记）。' +
      '只读操作。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '对 id/标题/cwd 的子串过滤' },
        team: { type: 'string', description: '编组名过滤' },
        includeSubagents: { type: 'boolean', description: '是否含子代理会话（默认 false）' },
        ungrouped: { type: 'boolean', description: '是否只列未分组会话（默认 false）' },
        limit: { type: 'number', description: '返回行数上限（默认 50）' },
      },
    },
    async handler(client, args) {
      const query = {};
      for (const key of ['filter', 'team']) {
        const v = optionalString(args, key);
        if (v !== undefined) query[key] = v;
      }
      for (const key of ['includeSubagents', 'ungrouped', 'limit']) {
        const v = args?.[key];
        if (v !== undefined && v !== null && v !== '') query[key] = v;
      }
      return client.request('GET', '/v1/list', { query });
    },
  },
  {
    name: 'dsh_task_models',
    description:
      '列出本部署可用的精确 LLM 路线目录（GET /v1/models）：providers（各 provider 及其 models 与可用 reasoning efforts——' +
      'id 部署特定，派发前用它取精确 id，绝不猜）、default（宿主默认路线）、pluginDefault（task-coordinator 设置区配置的插件默认路线，如有）、' +
      'failedProviders（探测失败的 provider 及原因）。' +
      '无参数。只读、无会话依赖。spawn 的 provider/model/reasoningEffort 参数应从这里取值。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler(client) {
      return client.request('GET', '/v1/models');
    },
  },
];

TOOLS.push({
  name: 'dsh_task_capabilities', description: '只读查询运行中桥与 coordinator 版本、能力和等待上限；缺席或禁用不伪装成可用。',
  inputSchema: { type: 'object', properties: {} },
  handler: client => client.request('GET', '/v1/capabilities'),
});
for (const tool of TOOLS) {
  const readOnly = !['dsh_task_spawn', 'dsh_task_send'].includes(tool.name);
  tool.annotations = { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly };
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);

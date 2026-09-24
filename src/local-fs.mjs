// local-fs.mjs —— 本地文件与命令工具（0.5.0 新增，默认关闭）
//
// 定位：让 ChatGPT 网页侧既能「用网页额度直接干活」（读/写/搜/跑命令，零 DSH 模型
// 消耗、毫秒级、拿到文件原文），也能「派给 DSH 省额度」（既有 7 个 task_* 工具）。
// 两种模式并存，由调用方按需选择——这是与 WebCodex 同类的能力面。
//
// ⚠️ 风险定位（务必读 README「本地文件与命令工具」节）：这些工具把本机文件系统与
// shell 暴露给一个**云端**模型会话，且网页侧没有人在环的确认闸门。提示注入（模型读到
// 的任何外部内容都可能是载体）可直接指挥它读写文件、执行命令。因此：
//   - 默认**全部关闭**：不设 env 则一个工具都不注册，既有链路零变化；
//   - 文件与执行是**两个独立开关**，可只开只读文件、不开 shell；
//   - 写与执行**每次调用都写审计日志**（stderr，tunnel-client 日志会收）；
//   - 这条链路自己的凭据**强制不可读**（见 PROTECTED_ALWAYS）。
//
// 纯模块：无 @deepseek-ai / 无第三方依赖，fs 与 exec 均可注入以便离线单测。

import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** read / exec 输出的默认字节上限（与桥 body 上限 256KB 同量级）。 */
export const DEFAULT_MAX_BYTES = 256 * 1024;
/** exec 默认超时（对齐 Codex tool_timeout_sec 默认 60s 的一半，留出 MCP 序列化余量）。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** grep 默认扫描文件数上限（零依赖遍历，必须有界，否则大目录会拖死）。 */
export const DEFAULT_GREP_MAX_FILES = 2_000;
/** grep 默认递归深度上限。 */
export const DEFAULT_GREP_MAX_DEPTH = 12;
/** listDir 默认/最大条目数（0.5.1：入参 limit 必须 clamp，否则回执体积由调用方决定，与 maxBytes 无关）。 */
export const DEFAULT_LIST_ENTRIES = 500;
export const MAX_LIST_ENTRIES = 5_000;
/** grep 默认/最大命中数（同上，clamp 后回执才真正有界）。 */
export const DEFAULT_GREP_MATCHES = 100;
export const MAX_GREP_MATCHES = 5_000;

/**
 * exec 传给子进程的环境变量白名单（0.5.1）。
 *
 * 0.5.0 用 `env: { ...process.env }` 全量继承，安全与正确性评审各自独立实测：一条
 * `local_exec{command:'node -e "console.log(process.env.TASK_BRIDGE_TOKEN)"'}` 就把桥 token
 * 打进 stdout 回给云端会话——而 `TASK_BRIDGE_TOKEN` 是 README 明确支持、优先级最高的注入方式。
 * 本机还实测存在 `MANA_API_KEY`、`MOONTONTECH_API_KEY` 等用户级秘密。
 * 这不是 exec 的固有风险，而是纯代码选择：不传全量 env 就能挡住。
 *
 * 策略改为「白名单 + 强制剔除」：只放行命令实际需要的系统变量，并额外按名字模式兜底剔除
 * 任何疑似秘密（防白名单外新增的系统变量里混进凭据）。
 */
export const EXEC_ENV_ALLOWLIST = [
  // POSIX / 通用
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR', 'USER', 'LOGNAME',
  // Windows 必需（缺 SystemRoot/ComSpec 会让大量命令与 .cmd 解析失败）
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'windir', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS',
  // Node 版本管理器（缺失会让 node/npm 命令找不到；不含凭据语义）
  'NODE_PATH', 'NVM_DIR', 'NVM_SYMLINK',
];
/** 名字命中即强制剔除（即使在白名单里）——最后一道兜底。 */
export const EXEC_ENV_SECRET_PATTERN = /(_?API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?KEY)/i;
/** 前缀命中即强制剔除：这条链路自己的配置与凭据，绝不外传给子进程。 */
export const EXEC_ENV_BLOCKED_PREFIXES = ['TASK_BRIDGE_', 'DSH_BRIDGE_', 'DSH_READBACK_'];

/**
 * 构造子进程环境：白名单过滤 + 强制剔除。
 * @param {NodeJS.ProcessEnv} [source] 源环境（默认 process.env；可注入以便单测）
 */
export function buildExecEnv(source = process.env) {
  const out = {};
  for (const key of EXEC_ENV_ALLOWLIST) {
    if (typeof source[key] !== 'string') continue;
    if (EXEC_ENV_SECRET_PATTERN.test(key)) continue;
    if (EXEC_ENV_BLOCKED_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = source[key];
  }
  // Windows 环境变量不区分大小写，但 Node 的 process.env 在 win32 上是大小写不敏感代理；
  // 为稳妥起见，再按小写键补一遍常见必需项（若源里是大写/小写变体）。
  if (process.platform === 'win32') {
    for (const [k, v] of Object.entries(source)) {
      if (typeof v !== 'string') continue;
      if (EXEC_ENV_SECRET_PATTERN.test(k)) continue;
      if (EXEC_ENV_BLOCKED_PREFIXES.some((p) => k.toUpperCase().startsWith(p))) continue;
      const lower = k.toLowerCase();
      if (['systemroot', 'comspec', 'pathext', 'temp', 'tmp', 'path', 'userprofile', 'appdata', 'localappdata', 'windir']
        .includes(lower) && !Object.keys(out).some((e) => e.toLowerCase() === lower)) {
        out[k] = v;
      }
    }
  }
  return out;
}

/** 工具入参校验失败。与 tools.mjs 的 ToolValidationError 同形（server 层统一映射）。 */
export class LocalToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalToolError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 凭据保护
// ---------------------------------------------------------------------------

/**
 * 路径规范化（canonical）：把「同一个文件的不同写法」收敛成唯一形式。
 *
 * 0.5.0 的守卫只做 `resolve()`（纯字符串规范化）+ 精确字符串比较，被安全评审实测击穿
 * 四条独立通道，读写双向：
 *  - **大小写变形**：`TASK-BRIDGE-TOKEN`、`c:\users\...`（Windows/macOS 文件系统不区分大小写）
 *  - **NTFS 备用数据流**：`token::$DATA`（`resolve` 不剥流名，`::` 之后原样保留）
 *  - **UNC 前缀**：`\\?\C:\...`、`\\.\C:\...`
 *  - **symlink / junction**：链接自身路径与目标路径字面不同
 * 因此这里必须：剥 ADS → 解析真实路径（realpath，覆盖 symlink/junction/UNC 与大小写归一）
 * → 在不区分大小写的平台上 lowercase。两侧（候选路径与保护清单）都要过这一层，否则比较无意义。
 *
 * realpath 失败（路径尚不存在，如 writeFile 的新文件）时退回 `resolve()`——此时无链接可解析，
 * 字符串形式已是最优；但仍执行剥 ADS 与 lowercase，所以「写一个不存在的大小写变形路径」同样被拦。
 *
 * @param {string} p 任意形式的路径
 * @returns {string} 规范化后的绝对路径
 */
export function canonical(p) {
  let s = String(p ?? '').trim();
  // 剥 NTFS 备用数据流：`file::$DATA`、`file:stream` 一律只留主路径。
  // 注意 Windows 盘符后的 `C:` 不是流分隔符，所以从索引 2 之后开始找。
  const adsIdx = s.indexOf('::', s.length > 1 && s[1] === ':' ? 2 : 0);
  if (adsIdx >= 0) s = s.slice(0, adsIdx);
  let real;
  try {
    // realpathSync.native 走 OS 原生 API：Windows 上返回带正确大小写的最终路径，
    // 并解析 symlink/junction/UNC；比 JS 实现更准且更快。
    real = realpathSync.native(s);
  } catch {
    real = resolve(s); // 不存在的路径（写新文件）：退回字符串规范化
  }
  // Windows 与 macOS 默认不区分大小写；POSIX 区分，不能 lowercase（否则两个不同文件被视为同一个）
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/**
 * 展示用路径：解析真实路径（覆盖 symlink/junction/UNC）但**保留 OS 的正确大小写**。
 * 与 canonical 的区别只在不 lowercase——canonical 用于比较，displayPath 用于回执。
 * 0.5.1 的初版把 canonical 同时用于两者，导致回执里的路径全变小写（`C:\Users\...` →
 * `c:\users\...`），模型和用户看到的是被改写过的路径。
 */
export function displayPath(p) {
  let s = String(p ?? '').trim();
  const adsIdx = s.indexOf('::', s.length > 1 && s[1] === ':' ? 2 : 0);
  if (adsIdx >= 0) s = s.slice(0, adsIdx);
  try {
    return realpathSync.native(s);
  } catch {
    // 路径尚不存在（writeFile 建新文件，父目录可能也要新建）：realpath 整体失败。
    // 逐级上溯到**最近的存在祖先**做 realpath，再把剩余段原样拼回——这样即使
    // `a/b/c.txt` 三层都不存在，也能借 `a` 的真实大小写还原出正确形式。
    // 否则 canonical 传进来的小写会原样出现在回执与审计行里（0.5.1 初版实测如此）。
    const resolved = resolve(s);
    let head = resolved;
    const tail = [];
    for (let i = 0; i < 40; i += 1) {
      const parent = dirname(head);
      if (parent === head) break;
      tail.unshift(head.slice(head.lastIndexOf(sep) + 1));
      head = parent;
      try {
        return join(realpathSync.native(head), ...tail);
      } catch { /* 该祖先也不存在，继续上溯 */ }
    }
    return resolved;
  }
}

/** 前缀匹配：child 是否等于 parent 或落在 parent 子树内（两侧都必须已 canonical）。 */
function withinTree(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 强制保护（**不可通过 env 解除**）：这条链路自己的凭据。
 *
 * 泄露它们等于链路被劫持，属自毁而非能力——网页 GPT 读走桥 token 后，凭据就永久留在
 * 云端对话记录里；读走 DSH 的 .credentials.yaml 则等于交出宿主模型凭据。所以这两个
 * 即使调用方显式要求「全盘不限」也拒绝，且拒绝理由不暴露文件内容。
 *
 * 返回 canonical 形式；调用方必须用 canonical 后的候选路径来比。
 */
export function protectedAlways(env = process.env) {
  const home = homedir();
  const list = [
    join(home, '.dsh', 'task-bridge-token'),
    join(home, '.dsh', '.credentials.yaml'),
  ];
  const custom = env.TASK_BRIDGE_TOKEN_FILE;
  if (typeof custom === 'string' && custom.trim()) list.push(resolve(custom.trim()));
  return list.map((p) => canonical(p));
}

/**
 * 默认保护（可用 `DSH_BRIDGE_FS_DENY_CREDENTIALS=0` 解除，解除时启动打强告警）：
 * 与这条链路无关、但泄露后果灾难性的常见凭据位置。
 *
 * 用「目录前缀 + 文件名模式」两类匹配：目录前缀覆盖 SSH/云凭据整棵树，文件名模式覆盖
 * 散落在项目里的 .env / 私钥 / pem。
 *
 * `.dsh` 整棵树在 0.5.1 加入：它除两个强制保护文件外还有 `settings.yaml`、`sessions/`、
 * `storages/`、`profiles/`（安全评审判定这些同样不该被云端会话读走）。
 */
export const PROTECTED_DIRS = ['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.dsh'];
export const PROTECTED_NAME_PATTERNS = [
  /^\.env(\..+)?$/i,          // .env / .env.local / .env.production
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|p12|pfx|key)$/i,
  /(^|[^a-z])credentials?\.(json|ya?ml)$/i,
  /(^|[\\/.])(kubeconfig|netrc|_netrc|pgpass|npmrc|pypirc)$/i,
];

/** 判断一个已 canonical 的绝对路径是否落在默认保护范围内。 */
export function isProtectedByDefault(absPath, home = homedir()) {
  const p = canonical(absPath);
  const homeCanonical = canonical(home);
  for (const dir of PROTECTED_DIRS) {
    if (withinTree(p, canonical(join(homeCanonical, dir)))) return true;
  }
  const base = p.slice(p.lastIndexOf(sep) + 1);
  return PROTECTED_NAME_PATTERNS.some((re) => re.test(base));
}

/**
 * 统一的路径守卫：canonical 化 + NUL 拒绝 + 三级凭据保护 + 用户追加黑名单。
 *
 * 三级保护**全部按 canonical 形式比较**，且强制保护与黑名单都做「精确 + 子树」双向匹配：
 *  - 候选在保护项子树内 → 拒绝（防把受保护目录当搜索根 / 读其子文件）
 *  - 保护项在候选子树内 → 同样拒绝（防把 `~/.dsh` 当根去 grep 出里面的 token；
 *    这是 0.5.0 被实测击穿的最短路径：一次 `local_grep(path=父目录)` 即读出凭据原文）
 *
 * @returns {string} canonical 后的绝对路径
 */
export function guardPath(rawPath, { env = process.env, op = 'read', home = homedir() } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new LocalToolError('invalid-params', '参数 path 缺失或不是非空字符串');
  }
  if (rawPath.includes('\0')) {
    throw new LocalToolError('invalid-params', '路径不得包含 NUL 字节');
  }
  const abs = canonical(rawPath);
  const verb = op === 'read' ? '读取' : op === 'exec' ? '以该路径为工作目录' : '写入';
  // 第一级：强制保护，不可解除。匹配「精确 + 候选落在保护项子树内」两种。
  //
  // 刻意**不**匹配反向（保护项落在候选子树内 → 拒绝该候选）：那会让任何*包含*受保护文件的
  // 目录都无法作为 grep/list 根——例如项目里有 .env 就搜不了整个项目，或 grep 用户主目录
  // 永远失败。真正的防线是递归遍历里的逐条目 guard（guardWalkEntry），它保证即使根被放行，
  // 受保护文件的内容与路径也不会出现在结果里，并被计入 skipped.protected 如实上报。
  // 「把 ~/.dsh 当搜索根」这种直指凭据目录的情形由第二级 PROTECTED_DIRS（含 .dsh）拦住。
  for (const denied of protectedAlways(env)) {
    if (abs === denied || withinTree(abs, denied)) {
      throw new LocalToolError(
        'credential-protected',
        `拒绝${verb}该路径：它是（或包含）本链路的凭据文件，读走会让凭据永久留在云端对话记录里（等同自毁）。此项保护不可通过配置解除；如确需轮换该文件，请在本机手工操作。`,
      );
    }
  }

  // 第二级：默认保护，可显式解除（解除时 createLocalTools 已在启动期打过强告警）
  const denyCredentials = env.DSH_BRIDGE_FS_DENY_CREDENTIALS !== '0';
  if (denyCredentials && isProtectedByDefault(abs, home)) {
    throw new LocalToolError(
      'credential-protected',
      `拒绝${verb}该路径：命中默认凭据保护（SSH/云凭据/DSH 目录，或 .env/私钥/pem/credentials 类文件名）。如确需访问，启动 bridge-mcp 时设 DSH_BRIDGE_FS_DENY_CREDENTIALS=0 解除（会在日志留强告警），或用 DSH_BRIDGE_FS_DENY 精确管理黑名单。`,
    );
  }
  // 默认保护还要挡「把受保护目录当根」：候选是 home 下某保护目录的祖先时无意义，
  // 但候选等于 home 本身时不能拒（否则任何搜索都做不了）——真正的防线是 walk 内逐文件 guard。

  // 第三级：用户追加黑名单（分隔符用 path.delimiter，Windows 为 `;`；含 `;` 的路径无法完整表达，见 README）
  const extra = env.DSH_BRIDGE_FS_DENY;
  if (typeof extra === 'string' && extra.trim()) {
    for (const pattern of extra.split(delimiter).map((s) => s.trim()).filter(Boolean)) {
      const target = canonical(pattern);
      if (abs === target || withinTree(abs, target)) {
        throw new LocalToolError('path-denied', `拒绝${verb}该路径：命中 DSH_BRIDGE_FS_DENY 黑名单项 ${pattern}`);
      }
    }
  }
  // 回执用 displayPath（保留 OS 正确大小写），比较用 canonical（小写 + 剥 ADS + 解析真实路径）。
  // Windows 文件系统不区分大小写，所以对小写形式再跑一次 realpathSync.native 能拿回正确大小写。
  return displayPath(abs);
}

/**
 * 递归遍历用的**逐文件**守卫：walk 发现的每个候选都要过一遍保护检查。
 *
 * 0.5.0 只在搜索/列举的**根**上调 guardPath，walk 内部对发现的文件从不检查——于是
 * `local_grep(path=父目录)` 一次调用就能读出 `~/.dsh/task-bridge-token`、`.env`、`*.pem`
 * 的**原文**，三层保护形同虚设（安全与正确性评审各自独立复现，且零测试覆盖）。
 * 更糟的是 README 推荐的「只开 LOCAL_FS 不开 shell」这个"更安全"配置恰恰是绕过生效的配置。
 *
 * 与 guardPath 的区别：**不抛错**，返回 null 表示跳过。遍历中命中保护是常态（任何仓库里
 * 都可能有 .env），抛错会让整次搜索失败；跳过并计数才是正确语义。
 *
 * @returns {string|null} 通过则返回 canonical 路径，被保护则返回 null
 */
export function guardWalkEntry(absPath, { env = process.env, home = homedir() } = {}) {
  // 必须先 canonical：调用方（grep/listDir 的 walk）传进来的路径是由 guardPath 返回的
  // displayPath（保留 OS 正确大小写）拼出来的，而保护清单是 canonical（Windows 下小写）。
  // 0.5.1 初版漏了这一步，导致 DSH_BRIDGE_FS_DENY 黑名单在递归遍历里**完全不生效**。
  const p = canonical(absPath);
  for (const denied of protectedAlways(env)) {
    if (p === denied || withinTree(p, denied)) return null;
  }
  if (env.DSH_BRIDGE_FS_DENY_CREDENTIALS !== '0' && isProtectedByDefault(p, home)) return null;
  const extra = env.DSH_BRIDGE_FS_DENY;
  if (typeof extra === 'string' && extra.trim()) {
    for (const pattern of extra.split(delimiter).map((s) => s.trim()).filter(Boolean)) {
      const target = canonical(pattern);
      if (p === target || withinTree(p, target)) return null;
    }
  }
  return absPath;
}

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

/** 从 env 解析本地工具配置（全部带默认值，非法值回退默认而非猜测）。 */
export function resolveLocalConfig(env = process.env) {
  const positiveInt = (v, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    fsEnabled: env.DSH_BRIDGE_LOCAL_FS === '1',
    execEnabled: env.DSH_BRIDGE_LOCAL_EXEC === '1',
    maxBytes: positiveInt(env.DSH_BRIDGE_FS_MAX_BYTES, DEFAULT_MAX_BYTES),
    execTimeoutMs: positiveInt(env.DSH_BRIDGE_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS),
    grepMaxFiles: positiveInt(env.DSH_BRIDGE_GREP_MAX_FILES, DEFAULT_GREP_MAX_FILES),
    grepMaxDepth: positiveInt(env.DSH_BRIDGE_GREP_MAX_DEPTH, DEFAULT_GREP_MAX_DEPTH),
    denyCredentials: env.DSH_BRIDGE_FS_DENY_CREDENTIALS !== '0',
    defaultCwd: typeof env.DSH_BRIDGE_LOCAL_CWD === 'string' && env.DSH_BRIDGE_LOCAL_CWD.trim()
      ? resolve(env.DSH_BRIDGE_LOCAL_CWD.trim())
      : process.cwd(),
    /**
     * 审计落盘路径（0.5.1）。安全评审实测：审计行只走 stderr，而生产部署下 stderr
     * **不进 tunnel-client 的日志文件**（3.9MB debug 日志、两次启动、零命中；profile 的
     * `mcp.commands[]` 只有 channel 与 command 两个字段，没有 stderr 重定向口子）。
     * 于是「写与执行都留审计」这条被列为无人在环风险的唯一补偿性控制，在主要部署形态下
     * 根本不落盘、事后无从追溯。所以给 bridge-mcp 自己的落盘通道，不依赖宿主采集。
     * 未设则只走 stderr（保持 0.5.0 行为）。
     */
    auditFile: typeof env.DSH_BRIDGE_AUDIT_FILE === 'string' && env.DSH_BRIDGE_AUDIT_FILE.trim()
      ? resolve(env.DSH_BRIDGE_AUDIT_FILE.trim())
      : null,
  };
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** 统计信息投影（各工具共用，避免把 stat 全量字段倒给模型）。 */
function statProjection(st) {  return {
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

function assertWithinLimit(byteLength, maxBytes, what) {
  if (byteLength > maxBytes) {
    throw new LocalToolError(
      'too-large',
      `${what}为 ${byteLength} 字节，超过上限 ${maxBytes} 字节。读取大文件请用 offset/limit 分页；或启动时设更大的 DSH_BRIDGE_FS_MAX_BYTES。`,
    );
  }
}

/**
 * 按**字节**裁剪字符串（0.5.1）。
 *
 * 0.5.0 用 `String.prototype.slice(0, maxBytes)`，那是 UTF-16 码元语义：CJK 内容下 1 码元
 * = 3 字节，实测 10 万汉字产出 100005 码元 / 300015 字节，而声明的上限是 262144——即
 * 「256KB 字节上限」在多字节内容下被突破约 3 倍（4 字节字符最坏 4 倍）。
 * 这里改为编码回 UTF-8 后按字节切，并避免切在多字节序列中间产生 U+FFFD。
 */
function sliceBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // 回退到 UTF-8 字符边界：0xC0-0xFF 开头的字节是首字节，落在其上的切割点要往前挪
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 造五个本地工具。fs / spawnFn / logger 均可注入以便离线单测。
 * @param {{ env?: NodeJS.ProcessEnv, fs?: object, spawnFn?: Function, logger?: {info?:Function,warn?:Function}, config?: object }} [deps]
 */
export function createLocalTools(deps = {}) {
  const env = deps.env ?? process.env;
  const config = deps.config ?? resolveLocalConfig(env);
  const fsImpl = deps.fs ?? { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync };
  const spawnImpl = deps.spawnFn ?? spawn;
  // 杀进程树用**独立的** spawn（不复用 spawnFn）：spawnFn 是给被测命令用的、单测会注入
  // fake，若杀树也走它，超时路径在测试里就永远杀不动真进程，等于把最危险的分支测空了。
  const treeKillFn = deps.treeKillFn ?? spawn;
  // exec 子进程环境的来源（默认 process.env；可注入以便单测断言剔除逻辑）
  const envSource = deps.execEnv ?? process.env;
  // 审计落盘（0.5.1）：DSH_BRIDGE_AUDIT_FILE 设了就 append 一行一条。失败只 warn 不抛——
  // 审计不可用不该让工具调用失败，但必须让人知道审计断了。
  const auditSink = (line) => {
    if (!config.auditFile) return;
    try {
      appendFileSync(config.auditFile, `${line}\n`, 'utf8');
    } catch (error) {
      process.stderr.write(`[bridge-mcp] WARN 审计落盘失败（${config.auditFile}）：${error?.message ?? error}\n`);
    }
  };
  const logger = deps.logger ?? {
    info: (m) => {
      process.stderr.write(`[bridge-mcp] ${m}\n`);
      if (m.startsWith('AUDIT ')) auditSink(m);
    },
    warn: (m) => process.stderr.write(`[bridge-mcp] WARN ${m}\n`),
  };
  const guard = (p, op) => guardPath(p, { env, op });
  // 递归遍历的逐条目守卫（不抛错，返回 null 即跳过）。0.5.1 修复：0.5.0 只在根上 guard，
  // walk 内部对发现的文件从不检查，于是一次 local_grep(path=父目录) 就能读出
  // ~/.dsh/task-bridge-token、.env、*.pem 的原文——三层保护形同虚设，且零测试覆盖。
  const guardEntry = (p) => guardWalkEntry(p, { env });

  // 解除默认凭据保护时留强告警：这是不可逆的风险放大，必须在日志里可见。
  if (config.fsEnabled && !config.denyCredentials) {
    logger.warn('DSH_BRIDGE_FS_DENY_CREDENTIALS=0 —— 默认凭据保护已解除：网页会话可读取 ~/.ssh、.env、私钥等。仅在你明确知道后果时保留此设置。');
  }

  return {
    /** 读文本文件，支持 offset/limit 分页（行语义，对齐编辑器习惯）。 */
    readFile(args = {}) {
      const abs = guard(args.path, 'read');
      let st;
      try {
        st = fsImpl.statSync(abs);
      } catch {
        throw new LocalToolError('not-found', `文件不存在或不可读：${abs}`);
      }
      if (st.isDirectory()) throw new LocalToolError('is-directory', `${abs} 是目录，请用 local_list_dir`);
      assertWithinLimit(st.size, config.maxBytes, '文件');

      const raw = fsImpl.readFileSync(abs);
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      // 读回后**复检**字节数（0.5.1）：0.5.0 只校验 stat.size，读回的数据从不再比对上限。
      // 后果是读一个正在被追加的日志就能拿到超过 maxBytes 的内容（用模块的 fs 注入 seam
      // 实测：stat.size=100 而实际返回 5000002 字符），攻击者还能在 stat 与 read 之间扩容。
      assertWithinLimit(buf.length, config.maxBytes, '文件实际读取字节数');
      // 二进制检测：前 8KB 内出现 NUL 即判为二进制，不往模型上下文里灌乱码
      const probe = buf.subarray(0, Math.min(buf.length, 8192));
      if (probe.includes(0)) {
        throw new LocalToolError('binary-file', `${abs} 含 NUL 字节，判定为二进制文件，不返回内容（size=${st.size}）。如需处理请改用 local_exec 配合专门的命令行工具。`);
      }

      const text = buf.toString('utf8');
      const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
      const lines = text.split('\n');
      const sliced = limit === undefined ? lines.slice(offset) : lines.slice(offset, offset + limit);
      return {
        ok: true,
        path: abs,
        size: st.size,
        encoding: 'utf8',
        offset,
        returnedLines: sliced.length,
        totalLines: lines.length,
        truncatedByLimit: limit !== undefined && offset + limit < lines.length,
        // 带行号（cat -n 风格），让模型能精确引用位置
        content: sliced.map((l, i) => `${offset + i + 1}\t${l}`).join('\n'),
      };
    },

    /** 写文件：overwrite（默认）或 append。父目录缺失时递归创建。 */
    writeFile(args = {}) {
      const abs = guard(args.path, 'write');
      if (typeof args.content !== 'string') {
        throw new LocalToolError('invalid-params', '参数 content 缺失或不是字符串（写空文件请传 ""）');
      }
      const mode = args.mode === 'append' ? 'append' : 'overwrite';
      let existed = false;
      let previousSize = 0;
      let statUncertain = false;
      try {
        const st = fsImpl.statSync(abs);
        existed = true;
        previousSize = st.size;
        if (st.isDirectory()) throw new LocalToolError('is-directory', `${abs} 是目录，不能写`);
      } catch (error) {
        if (error instanceof LocalToolError) throw error;
        // 0.5.0 在这里一律 `existed = false`：若 statSync 因权限失败（EACCES）而文件其实存在，
        // 回执会谎报「新建」并 previousSize=0，随后覆写真实文件——调用方看不出覆盖了什么。
        // 现在区分「确实不存在」与「存在但 stat 不了」，后者如实标注。
        existed = (error?.code === 'ENOENT') ? false : null;
        if (existed === null) statUncertain = true;
      }
      const dir = dirname(abs);
      if (dir) fsImpl.mkdirSync(dir, { recursive: true });

      if (mode === 'append') fsImpl.appendFileSync(abs, args.content, 'utf8');
      else fsImpl.writeFileSync(abs, args.content, 'utf8');

      // 审计**前置于 statSync**（0.5.1）：0.5.0 把 statSync 放在审计行之前且不在 try 内，
      // 于是「写已落盘但 stat 抛错（EACCES / 并发删除 / EIO）」时审计行 0 条、回执退化成
      // internal-error——文件被改了却无痕，直接违反「每次写都留审计」这条声称的机械控制。
      const intendedBytes = Buffer.byteLength(args.content, 'utf8');
      logger.info(`AUDIT local_write_file path=${abs} mode=${mode} existed=${existed} previousSize=${previousSize} writtenBytes=${intendedBytes}`);

      let st = null;
      try {
        st = fsImpl.statSync(abs);
      } catch {
        // stat 失败不影响「写已发生」这一事实：如实返回已知信息，不谎报大小
        return {
          ok: true, path: abs, mode, existed, previousSize,
          newSize: mode === 'append' ? null : intendedBytes,
          statUnavailable: true,
          note: '写入已完成，但随后 stat 该文件失败（权限/并发删除/IO 错误），newSize 为按内容计算的预期字节数而非实测值',
        };
      }
      return { ok: true, path: abs, mode, existed, previousSize, newSize: st.size, mtime: st.mtime.toISOString() };
    },

    /** 列目录（默认单层，可递归但有界）。 */
    listDir(args = {}) {
      const abs = guard(args.path, 'read');
      let st;
      try {
        st = fsImpl.statSync(abs);
      } catch {
        throw new LocalToolError('not-found', `目录不存在或不可读：${abs}`);
      }
      if (!st.isDirectory()) throw new LocalToolError('not-directory', `${abs} 不是目录，请用 local_read_file`);

      const recursive = args.recursive === true;
      const maxEntries = Number.isInteger(args.limit) && args.limit > 0
        ? Math.min(args.limit, MAX_LIST_ENTRIES)
        : DEFAULT_LIST_ENTRIES;
      const entries = [];
      let truncated = false;
      let depthLimited = false;
      let skippedProtected = 0;

      const walk = (dir, depth) => {
        let names;
        try {
          names = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
          return; // 无权限的子目录跳过，不让整次列举失败
        }
        for (const ent of names) {
          if (entries.length >= maxEntries) { truncated = true; return; }
          const full = join(dir, ent.name);
          const isDir = ent.isDirectory();
          // 逐条目过保护检查（0.5.1 修复）：0.5.0 只在根上 guard，于是递归列举会把
          // ~/.dsh 下的凭据文件路径直接暴露给云端会话（配合 grep 即完整泄露）。
          // 目录也要检查——否则仍会递归进受保护子树。
          if (guardEntry(full) === null) { skippedProtected += 1; continue; }
          entries.push({
            path: full,
            name: ent.name,
            type: isDir ? 'dir' : ent.isSymbolicLink() ? 'symlink' : 'file',
          });
          if (recursive && isDir && !ent.name.startsWith('.')) {
            if (depth < config.grepMaxDepth) walk(full, depth + 1);
            else depthLimited = true; // 深度到顶必须如实报告，否则 truncated:false 会被读成「列举完整」
          }
        }
      };
      walk(abs, 0);
      return {
        ok: true, path: abs, recursive, count: entries.length, truncated,
        depthLimited, skippedProtected,
        ...(skippedProtected > 0 ? { note: `${skippedProtected} 个条目因凭据保护/黑名单被跳过，未列入` } : {}),
        entries,
      };
    },

    /** 内容正则搜索（零依赖遍历，有文件数与深度上限）。 */
    grep(args = {}) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      if (!pattern.trim()) throw new LocalToolError('invalid-params', '参数 pattern 缺失或为空');
      let re;
      try {
        re = new RegExp(pattern, args.caseInsensitive === true ? 'i' : '');
      } catch (error) {
        throw new LocalToolError('invalid-params', `正则不合法：${error.message}`);
      }
      const root = guard(args.path ?? config.defaultCwd, 'read');
      // clamp：0.5.0 的 limit 无上限，回执体积由调用方决定（实测 limit=1e8 时单文件模式
      // 回执 JSON 达 6.70MB），与 maxBytes 完全脱钩。
      const maxMatches = Number.isInteger(args.limit) && args.limit > 0
        ? Math.min(args.limit, MAX_GREP_MATCHES)
        : DEFAULT_GREP_MATCHES;
      const onlyMatching = args.onlyMatching === true;
      const matches = [];
      let filesScanned = 0;
      let truncated = false;
      let depthLimited = false;
      // 静默漏报计数器（0.5.1）：0.5.0 把超限/二进制/受保护文件直接 continue，
      // 却仍把它们算进 filesScanned，于是「扫了 N 个文件、只有 1 处命中、truncated:false」
      // 无法区分"确实没有"与"被跳过了"。现在逐项如实报告。
      let skippedOversize = 0;
      let skippedBinary = 0;
      let skippedProtected = 0;
      let skippedUnreadable = 0;
      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

      /** 在单个文件的文本里搜；命中上限由调用方负责置 truncated。 */
      const scanText = (filePath, buf) => {
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (!re.test(lines[i])) continue;
          matches.push({
            path: filePath,
            line: i + 1,
            text: onlyMatching ? (lines[i].match(re) ?? [])[0] ?? '' : lines[i].slice(0, 500),
          });
          if (matches.length >= maxMatches) { truncated = true; return; }
        }
      };

      /** 单文件读取 + 上限/二进制闸门（目录模式与单文件模式共用，0.5.1 起两者一致）。 */
      const scanFile = (filePath) => {
        if (guardEntry(filePath) === null) { skippedProtected += 1; return; }
        let st;
        try {
          st = fsImpl.statSync(filePath);
        } catch {
          skippedUnreadable += 1;
          return;
        }
        if (st.size > config.maxBytes) { skippedOversize += 1; return; } // 大文件跳过，不拖慢整次搜索
        let buf;
        try {
          buf = fsImpl.readFileSync(filePath);
        } catch {
          skippedUnreadable += 1;
          return;
        }
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (b.subarray(0, Math.min(b.length, 8192)).includes(0)) { skippedBinary += 1; return; } // 二进制跳过
        filesScanned += 1; // 只在真正扫描后计数，语义才诚实
        scanText(filePath, b);
      };

      const walk = (dir, depth) => {
        if (truncated) return;
        let names;
        try {
          names = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
          skippedUnreadable += 1;
          return;
        }
        for (const ent of names) {
          if (truncated) return;
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
            // 目录也过保护检查，否则会递归进受保护子树（如 ~/.dsh）
            if (guardEntry(full) === null) { skippedProtected += 1; continue; }
            if (depth < config.grepMaxDepth) walk(full, depth + 1);
            else depthLimited = true; // 深度到顶必须报告：0.5.0 静默停止下潜，truncated:false 被读成「搜全了」
            continue;
          }
          if (!ent.isFile()) continue;
          if (filesScanned + skippedOversize + skippedBinary >= config.grepMaxFiles) { truncated = true; return; }
          scanFile(full);
        }
      };

      let rootStat;
      try {
        rootStat = fsImpl.statSync(root);
      } catch {
        throw new LocalToolError('not-found', `搜索根不存在或不可读：${root}`);
      }
      if (rootStat.isFile()) {
        // 单文件模式：0.5.0 这条路径没有 size 上限也没有二进制闸门（实测 maxBytes=1024 时
        // 仍把 200MB 文件整体读入堆，rss +392MB；含 NUL 的文件也照搜并把乱码灌进上下文），
        // 且 filesScanned 恒为 0、limit 触顶不置 truncated。现在与目录模式共用 scanFile。
        scanFile(root);
      } else {
        walk(root, 0);
      }
      const skippedTotal = skippedOversize + skippedBinary + skippedProtected + skippedUnreadable;
      return {
        ok: true, pattern, root, filesScanned, matchCount: matches.length,
        // truncated 现在也覆盖「有文件被跳过」——否则调用方无法知道结果不完整
        truncated: truncated || skippedTotal > 0,
        limitTruncated: truncated,
        depthLimited,
        skipped: {
          total: skippedTotal, oversize: skippedOversize, binary: skippedBinary,
          protected: skippedProtected, unreadable: skippedUnreadable,
        },
        ...(skippedTotal > 0
          ? { note: `有 ${skippedTotal} 个文件/目录被跳过（超限 ${skippedOversize}、二进制 ${skippedBinary}、凭据保护 ${skippedProtected}、不可读 ${skippedUnreadable}），结果不完整；调大 DSH_BRIDGE_FS_MAX_BYTES 或收窄 path 可改善` }
          : {}),
        matches,
      };
    },

    /**
     * 执行本地命令。**风险最高的工具**：等同把本机 shell 交给云端模型会话。
     * Windows 上必须经 shell（否则 .cmd/内置命令不可用），这也意味着命令串会被
     * shell 二次解析——`& | ^ < >` 等都是元字符，不做任何转义。
     */
    exec(args = {}) {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) throw new LocalToolError('invalid-params', '参数 command 缺失或为空');
      const cwd = args.cwd ? guard(args.cwd, 'exec') : config.defaultCwd;
      const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
        ? Math.min(args.timeoutMs, config.execTimeoutMs)
        : config.execTimeoutMs;

      return new Promise((resolvePromise) => {
        let stdout = '';
        let stderr = '';
        // 字节计数与 maxBytes 比较（0.5.1）；字符串长度是 UTF-16 码元，CJK 下会低估 3 倍
        let stdoutBytes = 0;
        let stderrBytes = 0;
        // 每流一个 StringDecoder：多字节字符跨 chunk 边界时不会腰斩成 U+FFFD
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        let decodersFlushed = false;
        let killedByLimit = false;
        let timedOut = false;
        let settled = false;
        let treeKillDone = false;

        const child = spawnImpl(command, {
          cwd,
          shell: true,           // Windows 必需（否则 .cmd 与内置命令不可用）；POSIX 上也让 `|`、`>`、`&&` 可用
          windowsHide: true,
          // detached 让子进程成为**新进程组的组长**，POSIX 上才能用 `process.kill(-pid)` 杀整棵树。
          // 0.5.0 没设它，`kill -9 -<child.pid>` 里的 child.pid 不是任何 PGID → ESRCH，孙进程成孤儿
          // 继续跑（正确性评审推断；本机无 POSIX 环境未实测）。Windows 上该选项无副作用。
          detached: process.platform !== 'win32',
          // 白名单 env（0.5.1）：全量继承会让一条 `node -e "console.log(process.env.TASK_BRIDGE_TOKEN)"`
          // 把桥 token 送进云端对话记录——评审双方独立实测，本机确有 MANA_API_KEY 等用户级秘密。
          env: buildExecEnv(envSource),
        });

        /**
         * 杀整棵进程树。
         *
         * **不能依赖 spawn 的 `timeout` 选项，也不能只靠 `child.kill()`**——本机实测
         * （Windows，`shell:true`）：`child.kill('SIGKILL')` 只杀掉直接子进程（shell），
         * 孙进程（真正的命令）继续持有 stdout 管道，于是 `exit` 触发而 **`close` 永不触发**，
         * Promise 挂死到孙进程自己跑完（500ms 的超时实测变成 30s）。
         *
         * **也不能在 taskkill 之后立刻同步 `child.kill()`**（0.5.0 的错误）：taskkill 是异步
         * 子进程，同步 kill 会先把 shell 杀掉，等 taskkill 去查 PID 时进程已不存在——实测
         * `taskkill exit=128「没有找到进程」`，孙进程活到 5800ms/6000ms 自然结束，而回执 note
         * 却声称「已杀整棵进程树」。所以顺序必须是：**先 taskkill 杀树，它自己收尾后再兜底 kill**。
         *
         * 另外 taskkill/kill 的 spawn **必须挂 `error` 监听器**：0.5.0 的 try/catch 只能捕获同步
         * 抛出，而 spawn 失败是异步 `'error'` 事件 → EventEmitter 抛未捕获异常，**整个 MCP server
         * 崩溃，连带 7 个桥工具一起不可用**（实测 `exit=9 UNCAUGHT:spawn taskkill ENOENT`）。
         */
        const treeKill = () => {
          if (treeKillDone) return;
          treeKillDone = true;
          const pid = child.pid;
          const fallbackKill = () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } };
          if (pid === undefined || pid === null) { fallbackKill(); return; }

          if (process.platform === 'win32') {
            let tk;
            try {
              tk = treeKillFn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } catch {
              fallbackKill();
              return;
            }
            // 必须挂 error 监听：ENOENT（PATH 被裁剪）/ EACCES（AppCompat 拦截）都是异步事件，
            // 不挂就崩掉整个 server。同时 resume() 掉 stdio 防管道缓冲阻塞。
            tk.on('error', () => { fallbackKill(); });
            tk.stdout?.resume?.();
            tk.stderr?.resume?.();
            // taskkill 成功杀掉树后 shell 会随之退出；无论成败都在它结束后兜底 kill 一次。
            tk.on('close', () => { fallbackKill(); });
            // taskkill 自身也可能挂住，给它一个上界
            const tkTimer = setTimeout(fallbackKill, 2000);
            if (typeof tkTimer.unref === 'function') tkTimer.unref();
          } else {
            // POSIX：detached:true 后 child.pid 即 PGID，用 process.kill 直接发信号，
            // 不依赖外部 /bin/kill 可执行文件（裁剪镜像里可能没有）。
            try { process.kill(-pid, 'SIGKILL'); } catch { /* ESRCH/EPERM：已退出或无权 */ }
            fallbackKill();
          }
        };

        const timer = timeoutMs > 0
          ? setTimeout(() => { timedOut = true; treeKill(); }, timeoutMs)
          : null;
        if (timer && typeof timer.unref === 'function') timer.unref(); // 别把进程吊住

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          // 显式销毁 stdio 流：被 taskkill /T /F 终止的进程树仍可能留有管道句柄，
          // 不销毁则持有者（本进程）的 event loop 要等到句柄自然关闭——实测 500ms 的
          // 超时会让宿主进程多活满脚本的整个生命周期（30s 脚本 → 30s 悬挂）。
          // 常驻 server 上这表现为句柄泄漏，测试 runner 上表现为 duration 虚高。
          try { child.stdout?.destroy(); } catch { /* 已关闭 */ }
          try { child.stderr?.destroy(); } catch { /* 已关闭 */ }
          // 审计：记命令原文（命令不是秘密）；输出内容不记，可能含敏感数据
          logger.info(`AUDIT local_exec cwd=${cwd} timeoutMs=${timeoutMs} exit=${result.exitCode} timedOut=${result.timedOut} command=${command}`);
          resolvePromise(result);
        };

        const buildResult = (exitCode, signal) => {
          // 收尾 flush 解码器：StringDecoder 可能还留着半个多字节字符。只 flush 一次
          // （close 与 exit 都可能触发 buildResult，settled 之前的那次才算数）。
          if (!decodersFlushed) {
            decodersFlushed = true;
            stdout += outDecoder.end();
            stderr += errDecoder.end();
          }
          return {
          // 超时下退出码可能是任意值（被 taskkill /F 杀），以 timedOut 标志为准而非信号码
          ok: !timedOut && exitCode === 0,
          command,
          cwd,
          exitCode,
          signal: signal ?? null,
          timedOut,
          outputTruncated: killedByLimit,
          stdoutBytes,
          stderrBytes,
          // 按字节裁剪（0.5.1）：0.5.0 用 String.slice 按 UTF-16 码元裁，CJK 内容下实际载荷
          // 可达上限 3 倍（实测 10 万汉字 = 100005 码元 / 300015 字节，上限 262144）。
          stdout: sliceBytes(stdout, config.maxBytes),
          stderr: sliceBytes(stderr, config.maxBytes),
          ...(timedOut
            ? { note: `命令超过 ${timeoutMs}ms 上限，已终止其进程树（Windows 走 taskkill /T /F，POSIX 走进程组信号）。需要更长时间请在启动 bridge-mcp 时设更大的 DSH_BRIDGE_EXEC_TIMEOUT_MS，或改用 local_read_file/local_grep 等专用工具。` }
            : killedByLimit
              // 0.5.0 在输出超限被杀时只报「退出码 null（信号 SIGKILL）；超时上限 …」，
              // 既说退出码 null 又提超时上限，且从不解释真因是输出超限。
              ? { note: `命令输出超过 ${config.maxBytes} 字节上限，已终止其进程树并截断输出（outputTruncated=true）。` }
              : exitCode === 0 ? {} : { note: `命令以退出码 ${exitCode} 结束${signal ? `（信号 ${signal}）` : ''}；超时上限 ${timeoutMs}ms` }),
          };
        };

        const append = (which, chunk) => {
          // 超限后**停止累积**（0.5.1）：0.5.0 只阻止再次 treeKill，却继续 `stdout += text`，
          // 于是峰值内存由「子进程被杀前能灌多快」决定而非 maxBytes——实测单次 300MB 洪水
          // 让 rss 从 90MB 涨到 885MB。
          if (killedByLimit) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          // StringDecoder 处理多字节字符跨 chunk 边界：0.5.0 直接 chunk.toString('utf8')，
          // 大输出必现乱码（实测 400KB 中文出现 10 个 U+FFFD，900KB 出现 20 个）。
          const text = (which === 'out' ? outDecoder : errDecoder).write(buf);
          if (which === 'out') { stdout += text; stdoutBytes += buf.length; }
          else { stderr += text; stderrBytes += buf.length; }
          if (stdoutBytes + stderrBytes > config.maxBytes) {
            killedByLimit = true;
            treeKill();
          }
        };
        child.stdout?.on('data', (c) => append('out', c));
        child.stderr?.on('data', (c) => append('err', c));
        child.on('error', (error) => finish({
          ok: false, code: 'exec-failed', error: error.message, command, cwd, exitCode: null, timedOut,
        }));
        child.on('close', (exitCode, signal) => finish(buildResult(exitCode, signal)));
        // `exit` 兜底：被杀后孙进程仍可能持有管道导致 close 不来（见 treeKill 注释）。
        // 给 250ms 让已缓冲的 stdout/stderr 落地，再据 exit 结果收口——宁可少几个尾字节，
        // 也不能让工具调用永久挂起（那会撞穿 MCP tool_timeout_sec，表现成"整个会话卡死"）。
        child.on('exit', (exitCode, signal) => {
          if (settled) return;
          const code = exitCode;
          const sig = signal;
          const t = setTimeout(() => finish(buildResult(code, sig)), 250);
          if (typeof t.unref === 'function') t.unref();
        });
      });
    },
  };
}

/**
 * 按 env 门控造出 MCP 工具定义数组（含 inputSchema/outputSchema/handler）。
 * 默认（不设任何 env）返回空数组——既有 7 工具链路零变化。
 */
export function buildLocalTools(deps = {}) {
  const env = deps.env ?? process.env;
  // 0.5.0 这里忽略 deps.config 自行重算，随后 `{ ...deps, config }` 又把注入值覆盖掉——
  // server.mjs 传的 LOCAL_CONFIG 实际从未生效（同进程同 env 值恒等，无行为差异，但误导维护者）。
  const config = deps.config ?? resolveLocalConfig(env);
  if (!config.fsEnabled && !config.execEnabled) return [];
  const impl = createLocalTools({ ...deps, env, config });
  const tools = [];

  if (config.fsEnabled) {
    tools.push(
      {
        name: 'local_read_file',
        // annotations 让 MCP 客户端能对本工具加**机械**闸门；只写在 description 里是纪律不是防线。
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
          '读取本机文本文件（直接读磁盘，不经 DSH 任务会话，因此**不消耗任何模型额度**、毫秒级返回文件原文）。' +
          '参数：path（必填，绝对或相对路径）；offset（可选，起始行号，0 基）；limit（可选，返回行数）。' +
          '回执含带行号的 content（cat -n 风格）、totalLines、truncatedByLimit。' +
          '限制：超过 DSH_BRIDGE_FS_MAX_BYTES（默认 256KB）拒绝并提示分页；含 NUL 的二进制文件拒绝返回内容；' +
          '本链路凭据文件与默认凭据保护范围（~/.ssh、.env、私钥等）一律拒绝。' +
          '大文件请用 offset/limit 分页，不要反复整读。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对路径基于 bridge-mcp 进程 cwd 或 DSH_BRIDGE_LOCAL_CWD）' },
            offset: { type: 'number', description: '起始行号（0 基，默认 0）' },
            limit: { type: 'number', description: '返回行数（默认到文件末尾）' },
          },
          required: ['path'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, path: { type: 'string' }, size: { type: 'number' },
            offset: { type: 'number' }, returnedLines: { type: 'number' }, totalLines: { type: 'number' },
            truncatedByLimit: { type: 'boolean' }, content: { type: 'string' },
          },
          required: ['ok', 'path'],
        },
        async handler(_client, args) { return impl.readFile(args); },
      },
      {
        name: 'local_write_file',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description:
          '写入本机文件（overwrite 覆盖（默认）/ append 追加）。父目录缺失时递归创建。' +
          '参数：path（必填）；content（必填，字符串；写空文件传 ""）；mode（可选）。' +
          '回执含 existed / previousSize / newSize，便于确认是新建还是覆盖。' +
          '⚠️ 每次调用都写审计日志（路径+模式+字节数，不含内容）。⚠️ 这会让**云端模型会话**直接改动你的磁盘文件，' +
          '且没有人在环的确认闸门——提示注入可指挥它篡改仓库。建议只在 git 工作树内使用，写完立刻 git diff 复核。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string', description: '文件内容全文' },
            mode: { type: 'string', enum: ['overwrite', 'append'], description: '默认 overwrite' },
          },
          required: ['path', 'content'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, path: { type: 'string' }, mode: { type: 'string' },
            existed: { type: 'boolean' }, previousSize: { type: 'number' }, newSize: { type: 'number' },
            mtime: { type: 'string' },
          },
          required: ['ok', 'path', 'mode'],
        },
        async handler(_client, args) { return impl.writeFile(args); },
      },
      {
        name: 'local_list_dir',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
          '列目录（默认单层；recursive:true 递归，但跳过隐藏目录且有深度上限）。' +
          '参数：path（必填）；recursive（可选）；limit（可选，默认 500 条）。' +
          '回执 entries[] 每项含 path/name/type（file|dir|symlink），truncated 表示被 limit 截断。' +
          '无权限的子目录静默跳过，不让整次列举失败。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            recursive: { type: 'boolean' },
            limit: { type: 'number' },
          },
          required: ['path'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, path: { type: 'string' }, recursive: { type: 'boolean' },
            count: { type: 'number' }, truncated: { type: 'boolean' }, entries: { type: 'array' },
          },
          required: ['ok', 'path', 'entries'],
        },
        async handler(_client, args) { return impl.listDir(args); },
      },
      {
        name: 'local_grep',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
          '按正则在目录树或单个文件里搜内容（零依赖遍历，非 ripgrep）。' +
          '参数：pattern（必填，JS 正则语法）；path（可选，默认 bridge-mcp 的 cwd）；' +
          'caseInsensitive / onlyMatching / limit（可选，默认最多 100 处命中）。' +
          '自动跳过 node_modules/.git/dist/build/coverage 与隐藏目录、跳过二进制与超限大文件；' +
          '回执含 filesScanned 与 truncated（受 DSH_BRIDGE_GREP_MAX_FILES/MAX_DEPTH 约束）。' +
          '大仓库搜索有界，命中被截断时请缩小 path 或收紧 pattern。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'JS 正则（注意 \\d 需写 \\\\d）' },
            path: { type: 'string', description: '目录或单个文件；缺省为 bridge-mcp 进程 cwd' },
            caseInsensitive: { type: 'boolean' },
            onlyMatching: { type: 'boolean', description: '只返回命中片段而非整行' },
            limit: { type: 'number' },
          },
          required: ['pattern'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, pattern: { type: 'string' }, root: { type: 'string' },
            filesScanned: { type: 'number' }, matchCount: { type: 'number' },
            truncated: { type: 'boolean' }, matches: { type: 'array' },
          },
          required: ['ok', 'matches'],
        },
        async handler(_client, args) { return impl.grep(args); },
      },
    );
  }

  if (config.execEnabled) {
    tools.push({
      name: 'local_exec',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        '在本机执行 shell 命令并返回 stdout/stderr。**风险最高的工具**：等同把本机 shell 交给云端模型会话，' +
        '没有人在环确认。命令经 shell 解释（Windows 上是 cmd.exe），`& | ^ < >` 等都是元字符、不做转义。' +
        '参数：command（必填）；cwd（可选，默认 bridge-mcp 进程 cwd）；timeoutMs（可选，上限受 DSH_BRIDGE_EXEC_TIMEOUT_MS 约束，默认 30000）。' +
        '回执含 exitCode/signal/timedOut/stdout/stderr；输出总量超 DSH_BRIDGE_FS_MAX_BYTES（默认 256KB）即 SIGKILL 并置 outputTruncated。' +
        '⚠️ 每次调用都写审计日志（命令原文 + cwd + 退出码；输出内容不记，可能含敏感数据）。' +
        '优先用 local_read_file/local_grep 而非 cat/findstr/grep——它们更快、有分页、且不触发 shell 解析。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整命令串（经 shell 解释）' },
          cwd: { type: 'string', description: '工作目录；缺省为 bridge-mcp 进程 cwd' },
          timeoutMs: { type: 'number', description: '超时，钳制到 DSH_BRIDGE_EXEC_TIMEOUT_MS 上限' },
        },
        required: ['command'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }, command: { type: 'string' }, cwd: { type: 'string' },
          exitCode: { type: ['number', 'null'] }, signal: { type: ['string', 'null'] },
          timedOut: { type: 'boolean' }, outputTruncated: { type: 'boolean' },
          stdout: { type: 'string' }, stderr: { type: 'string' }, note: { type: 'string' },
          code: { type: 'string' }, error: { type: 'string' },
        },
        required: ['ok'],
      },
      async handler(_client, args) { return impl.exec(args); },
    });
  }

  return tools;
}

/** 本地工具启用时追加到 initialize instructions 的纪律条（未启用则不出现）。 */
export function buildLocalInstructions(config = resolveLocalToolsConfig()) {
  const lines = [];
  if (config.fsEnabled) {
    lines.push('本地文件工具（local_read_file / local_write_file / local_list_dir / local_grep）直接读写本机磁盘，不经 DSH 任务会话、不消耗模型额度、毫秒级返回原文。优先用它们读代码与配置，而不是 spawn 一个任务让 DSH agent 去读（后者慢、消耗 DSH 额度、且只能拿到尾部摘要）。');
    lines.push('写文件纪律：local_write_file 会让云端会话直接改动磁盘且无人在环确认——只在用户明确授权的路径内写，写完主动提示用户 git diff 复核；不得写本链路凭据文件（会被拒绝），默认也拒绝 ~/.ssh、.env、私钥类路径。');
  }
  if (config.execEnabled) {
    lines.push('local_exec 把本机 shell 交给云端会话，是风险最高的工具：能用 local_read_file/local_grep 解决的绝不用 cat/findstr/grep；破坏性命令（rm/del/format/git push --force/git reset --hard）必须先向用户确认再执行，不得自行决定。');
  }
  return lines;
}

/** 便于 server 层单独取配置（不重复解析）。 */
export function resolveLocalToolsConfig(env = process.env) {
  return resolveLocalConfig(env);
}

/** 导出内部常量供测试断言（非公开契约）。 */
export const _internals = { assertWithinLimit, statProjection, isAbsolute };

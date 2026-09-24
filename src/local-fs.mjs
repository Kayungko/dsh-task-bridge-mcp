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
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** read / exec 输出的默认字节上限（与桥 body 上限 256KB 同量级）。 */
export const DEFAULT_MAX_BYTES = 256 * 1024;
/** exec 默认超时（对齐 Codex tool_timeout_sec 默认 60s 的一半，留出 MCP 序列化余量）。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/**
 * `local_exec` 默认并发上限（0.5.2，`DSH_BRIDGE_EXEC_MAX_CONCURRENT`）。
 *
 * 0.5.1 之前没有任何并发闸：云端会话可以一次发起任意多条命令，每条都可能跑满
 * `execTimeoutMs`。后果是本机 CPU/句柄被打满、而 bridge-mcp 与隧道都要陪着扛——
 * 这既是资源问题也是可用性问题（同一进程还服务着 7 个桥工具）。
 * 超限**直接报错**而不是静默排队：排队会让调用方以为命令在跑，实际什么都没发生，
 * 而且队列本身又是新的无界资源。
 */
export const DEFAULT_EXEC_MAX_CONCURRENT = 4;
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
 * grep 整次调用的墙上时间预算（0.5.2 新增，`DSH_BRIDGE_GREP_TIMEOUT_MS`）。
 *
 * 为什么 grep 需要一个**总时间**上界，而不只是文件数/深度上界：正则的灾难性回溯
 * 与文件数无关，一个 33 字符的输入配一条 `(a+)+$` 就能让单线程 event loop 冻住——
 * 实测本机（Node v24.13.1）该模式与 `(x+x+)+y` 都跑过 15s 需外部 taskkill 才收场。
 * bridge-mcp 是常驻 stdio server，event loop 一冻，**7 个桥工具一起不可用**，而
 * 0.5.1 之前这条路径上没有任何时间控制（`limit` 只管命中数，管不到回溯）。
 */
export const DEFAULT_GREP_TIMEOUT_MS = 10_000;
/**
 * 传给 `vm` 的单次 timeout 下限。`vm` 的 `timeout` 不是「<=0 即无限」那么宽容的语义，
 * 而且预算耗尽时传 0/负数毫无意义——所以剩余预算低于此值时**直接停止遍历**并如实上报，
 * 绝不把非法值交给 vm。
 */
const MIN_VM_SLICE_MS = 25;

/**
 * 单文件匹配脚本（在 vm context 内执行）。
 *
 * ⚠️ 脚本文本是**写死的**；不可信的 `pattern` / `lines` / `flags` 只作为 contextified
 * sandbox 上的数据属性进入，绝不做字符串插值。实测把 `")); process.exit(1); ("`
 * 当 pattern 传进去，得到的只是 `Invalid regular expression`，不会执行任何代码。
 * 命中片段一律切到 500 字符——0.5.1 的 onlyMatching 分支不切，一条命中就能带回
 * 整行（压缩后的单行 JS 可达 maxBytes 量级），×maxMatches 就是几十 MB 的回执。
 */
const GREP_SCAN_SCRIPT = `
JSON.stringify((function () {
  var re = new RegExp(pattern, flags);
  var hits = [];
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (!re.test(line)) continue;
    var frag = onlyMatching ? String((line.match(re) || [''])[0]) : line;
    hits.push([i + 1, frag.length > 500 ? frag.slice(0, 500) : frag]);
    if (hits.length >= maxHits) break;
  }
  return { hits: hits, hitCap: hits.length >= maxHits };
})())
`;

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
 *
 * 0.5.2 补漏：0.5.1 的清单是「凭直觉列的常见项」，安全评审逐条核对后指出它漏掉了多个
 * **本机真实存在**的凭据位置——`.codex/auth.json`（Codex CLI）、`.config/gh/hosts.yml`
 * （GitHub CLI token）、`.git-credentials`、`.docker/config.json`、shell history（人手粘贴
 * 过 token 的地方）、浏览器 `Login Data`。这些既不在目录清单里，文件名也不匹配任何模式，
 * 于是网页会话一条 `local_read_file` 就能读走。以下每一项都对应一个真实的凭据存储位置。
 *
 * 目录项是**相对 home 的路径**，可以含分隔符（`.config/gh`）；`join` 会按平台归一。
 */
export const PROTECTED_DIRS = [
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.dsh',
  '.codex',        // Codex CLI：auth.json（OpenAI API key / OAuth 令牌）
  '.claude',       // Claude Code：settings.json 可含 env 秘密；projects/ 下是**完整会话转写**
  '.openviking',   // ov.conf：embedding / vlm / query_planner 的模型端点与凭据配置
  '.docker',       // Docker：config.json 里的 registry auth
  '.terraform.d',  // Terraform Cloud token（credentials.tfrc.json）
  '.config/gh',    // GitHub CLI：hosts.yml 里的 oauth_token
  '.config/gcloud', // Google Cloud ADC：credentials.db / application_default_credentials.json
  '.config/rclone', // rclone：rclone.conf 明文存各家对象存储凭据
  '.config/op',    // 1Password CLI
];
export const PROTECTED_NAME_PATTERNS = [
  /^\.env(\..+)?$/i,          // .env / .env.local / .env.production
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|p12|pfx|key|ppk)$/i, // ppk = PuTTY 私钥（0.5.2 补）
  /(^|[^a-z])credentials?\.(json|ya?ml)$/i,
  /(^|[\\/.])(kubeconfig|netrc|_netrc|pgpass|npmrc|pypirc)$/i,
  // ---- 0.5.2 补漏 ----
  /^\.git-credentials$/i,     // git credential store：明文存 https 用户名+密码/token
  /^auth\.json$/i,            // Codex CLI / Firebase 服务账号
  /^credentials$/i,           // 无扩展名的凭据文件（RubyGems ~/.gem/credentials 等）
  /^credentials\.(db|tfrc\.json)$/i, // gcloud 凭据库 / Terraform Cloud token
  /^secrets?\.(ya?ml|json)$/i, // k8s Secret / helm values 里的秘密清单
  /^rclone\.conf$/i,          // 不在 ~/.config/rclone 下时也拦住
  // shell / REPL 历史：人手粘贴过的 token、密码、连接串会长期留在这里
  /^\.(bash|zsh|sh|ksh|fish|psql|mysql|rediscli|python|node_repl|sqlite)_history$/i,
  /^\.lesshst$/i,
  // Chromium 系（Chrome/Edge）：Login Data 是密码库，Local State 存解密密钥
  /^login data(-journal)?$/i,
  /^local state$/i,
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

// ---------------------------------------------------------------------------
// 自身完整性保护（0.5.2）
// ---------------------------------------------------------------------------

/** 本模块文件路径，用于推出包根。 */
const SELF_MODULE_FILE = fileURLToPath(import.meta.url);

/**
 * bridge-mcp 自己的包根目录（canonical 形式）。
 *
 * 布局固定为 `<pkg>/src/local-fs.mjs`，向上两级即包根。这里必须用 `import.meta.url`
 * 而不是 `process.cwd()`：生产部署下 cwd 是 tunnel-client 的启动目录，与本包位置无关；
 * 而 profile 的 `command` 直接指向工作树的 `src/server.mjs`——**改写源码会在下次重启后
 * 被原样加载**，那是一条持久化通道，不是一次性破坏。
 *
 * @param {string} [moduleFile] 覆盖用（单测注入）
 */
export function selfPackageRoot(moduleFile = SELF_MODULE_FILE) {
  return canonical(dirname(dirname(moduleFile)));
}

/**
 * 写保护清单（canonical）：`local_write_file` 不得改写的路径。
 *
 * 只挡**写**、不挡读——本包是公开仓库，源码不是秘密；挡住读只会妨碍正常使用（例如让
 * 网页侧帮忙看桥的实现），却拦不住任何真实攻击。
 *
 * ⚠️ 作用域边界（别把它当万能防护，README 同样写明）：
 *  - `local_exec` 开着时这层保护**基本无意义**：攻击者有 shell，一条
 *    `echo > src/local-fs.mjs` 就绕过了，文件级写保护拦不住任意命令执行。
 *  - 所以它真正防的是「只开 LOCAL_FS、不开 shell」这个更窄配置下的**持久化改写**——
 *    没有 shell 时 write_file 是唯一能改动本包源码的通道。
 *  - 审计文件也在清单内且**不可解除**：审计是这条链路对外宣称的唯一补偿性控制，
 *    一次 write_file 就能截断清零的审计不构成控制。
 */
export function writeProtectedPaths({ env = process.env, selfRoot = selfPackageRoot(), auditFile = null } = {}) {
  const out = [];
  // 两项都必须 canonical：guardPath 拿来比的 `abs` 是 canonical 形式（Windows 下小写、
  // 剥 ADS、解析真实路径），清单里只要有一侧是原始大小写就**永不相等**，保护静默失效。
  // selfPackageRoot() 自己返回 canonical，所以默认路径没问题；但注入路径（单测、或将来
  // 从配置读入的包位置）不是——0.5.1 的 guardWalkEntry 就栽在同一个坑上（入参没 canonical
  // 导致 DSH_BRIDGE_FS_DENY 在递归遍历里完全不生效），这是该错误的第二次复发。
  if (auditFile) {
    out.push({ path: canonical(auditFile), overridable: false, why: '审计日志文件（截断它等于销毁这条链路唯一的操作留痕）' });
  }
  if (selfRoot && env.DSH_BRIDGE_FS_ALLOW_SELF_WRITE !== '1') {
    out.push({ path: canonical(selfRoot), overridable: true, why: 'bridge-mcp 自身包目录（改写其源码会在下次进程重启后被加载，构成持久化）' });
  }
  return out;
}

/**
 * 统一的路径守卫：canonical 化 + NUL 拒绝 + 三级凭据保护 + 用户追加黑名单 + 自身完整性。
 *
 * 三级凭据保护**全部按 canonical 形式比较**，且强制保护与黑名单都做「精确 + 子树」双向匹配：
 *  - 候选在保护项子树内 → 拒绝（防把受保护目录当搜索根 / 读其子文件）
 *  - 保护项在候选子树内 → 同样拒绝（防把 `~/.dsh` 当根去 grep 出里面的 token；
 *    这是 0.5.0 被实测击穿的最短路径：一次 `local_grep(path=父目录)` 即读出凭据原文）
 *
 * 0.5.2 追加第四级「自身完整性」，**只作用于 op==='write'**：见 writeProtectedPaths。
 *
 * @returns {string} canonical 后的绝对路径
 */
export function guardPath(rawPath, {
  env = process.env,
  op = 'read',
  home = homedir(),
  selfRoot = selfPackageRoot(),
  auditFile = null,
} = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new LocalToolError('invalid-params', '参数 path 缺失或不是非空字符串');
  }
  if (rawPath.includes('\0')) {
    throw new LocalToolError('invalid-params', '路径不得包含 NUL 字节');
  }
  const abs = canonical(rawPath);
  const verb = op === 'read' ? '读取' : op === 'exec' ? '以该路径为工作目录' : '写入';

  // 第零级（0.5.2）：白名单模式。放在最前面有两个理由：
  //  ① 它是最具体的拒绝原因（「不在你授权的范围内」比「这是凭据文件」信息量更少，
  //     顺带避免向云端会话泄露「那个位置确实存在一个受保护文件」）；
  //  ② 它是 AND 条件而非替代——通过白名单之后，下面三级保护照旧全部执行。
  const allowed = allowRoots(env);
  if (allowed && !withinAllowList(abs, allowed)) {
    throw new LocalToolError(
      'path-not-allowed',
      `拒绝${verb}该路径：DSH_BRIDGE_FS_ALLOW 白名单模式已启用，而该路径不在任何允许的根目录内。`
      + `当前允许 ${allowed.length} 个根。白名单只收窄访问范围，不会解除凭据保护。`,
    );
  }

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
  // 第四级（0.5.2）：自身完整性，**只挡写**。读放行——本包是公开仓库，源码不是秘密。
  // 生产 profile 直接跑工作树，改写 src/*.mjs 会在下次重启后被加载，所以这是持久化通道。
  // 注意作用域边界：local_exec 开着时攻击者有 shell，这层保护拦不住 `echo > src/...`；
  // 它真正防的是「只开文件不开 shell」配置下 write_file 这条唯一通道。
  if (op === 'write') {
    for (const item of writeProtectedPaths({ env, selfRoot, auditFile })) {
      if (abs === item.path || withinTree(abs, item.path)) {
        throw new LocalToolError(
          'self-write-protected',
          `拒绝写入该路径：它落在${item.why}内。`
          + (item.overridable
            ? '如确需从网页侧改写本包源码，启动 bridge-mcp 时设 DSH_BRIDGE_FS_ALLOW_SELF_WRITE=1 解除（会在日志留强告警）；更稳妥的做法是在本机编辑器里改、看过 diff 再重启。'
            : '此项保护不可通过配置解除。'),
        );
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
  // 白名单同样必须在**遍历内**逐条目检查（0.5.2）。这正是 0.5.0 递归绕过教训的同一条纪律：
  // 只在搜索根上生效的约束，等于对递归发现的文件完全不生效——而一次 grep 就能把整棵树读出来。
  const allowed = allowRoots(env);
  if (allowed && !withinAllowList(p, allowed)) return null;
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
    /** 同时在跑的 local_exec 上限；超限直接报 exec-busy，不静默排队。 */
    execMaxConcurrent: positiveInt(env.DSH_BRIDGE_EXEC_MAX_CONCURRENT, DEFAULT_EXEC_MAX_CONCURRENT),
    grepMaxFiles: positiveInt(env.DSH_BRIDGE_GREP_MAX_FILES, DEFAULT_GREP_MAX_FILES),
    grepMaxDepth: positiveInt(env.DSH_BRIDGE_GREP_MAX_DEPTH, DEFAULT_GREP_MAX_DEPTH),
    /** grep 整次调用的墙上时间预算；到点即停并如实上报，不让一条正则冻住 server。 */
    grepTimeoutMs: positiveInt(env.DSH_BRIDGE_GREP_TIMEOUT_MS, DEFAULT_GREP_TIMEOUT_MS),
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
 * 审计字段编码（0.5.2）：把自由文本编成**单行且可无歧义解析**的带引号形式。
 *
 * 缺陷：0.5.1 的 AUDIT 行是 `key=value` 直接拼接，而 `command` 与 `path` 都是调用方
 * 可控的自由文本。命令里带一个换行就能伪造任意多条审计行——例如
 * `command` 为 `dir` + LF + `AUDIT local_exec ... exit=0 ... command=rm -rf /`，
 * 事后取证时会看到一条从未发生过的记录，或一条被抹掉的记录。审计是这条链路对外宣称的
 * **唯一**补偿性控制（网页侧无人在环），可伪造即等于没有这个控制。
 *
 * 转义 `\\ " CR LF TAB` 后加双引号，结果正好是合法的 JSON 字符串体，`JSON.parse`
 * 能直接还原原文——格式对机器和人都确定。代价是 Windows 路径的反斜杠会翻倍
 * （`d:\\git\\...`），人眼仍可读。
 */
const AUDIT_ESCAPES = { '\\': '\\\\', '"': '\\"', '\r': '\\r', '\n': '\\n', '\t': '\\t' };
export function auditField(value) {
  return `"${String(value ?? '').replace(/[\\\"\r\n\t]/g, (c) => AUDIT_ESCAPES[c])}"`;
}

/**
 * 白名单根（0.5.2，`DSH_BRIDGE_FS_ALLOW`）。
 *
 * 0.5.1 只有黑名单：用户无法把网页侧的文件访问**收窄到单个项目目录**，只能在
 * 「全盘可读」与「逐个拉黑」之间二选一，而后者永远列不全。
 *
 * 语义（三条，缺一不可）：
 *  1. 未设或解析后为空 → 返回 `null`，表示白名单模式未启用，行为与 0.5.1 完全一致；
 *  2. 启用后，所有 fs 操作的路径与 exec 的 cwd 都必须落在某个根的子树内；
 *  3. **白名单只收窄、永不放宽**——它是与三级保护的 AND 关系，不是替代。
 *     落在白名单内的凭据路径照样被拒；否则「把 home 加进白名单」就等于一键解除
 *     全部凭据保护，那是把这个开关变成了自毁按钮。
 *
 * 分隔符用 `path.delimiter`（Windows `;` / POSIX `:`），与 `DSH_BRIDGE_FS_DENY` 一致。
 *
 * @returns {string[]|null} canonical 形式的根数组；未启用返回 null
 */
export function allowRoots(env = process.env) {
  const raw = env.DSH_BRIDGE_FS_ALLOW;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const roots = raw.split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => canonical(p));
  return roots.length > 0 ? roots : null;
}

/** 路径是否落在任一白名单根内（两侧都必须已 canonical）。 */
function withinAllowList(absCanonical, roots) {
  return roots.some((r) => absCanonical === r || withinTree(absCanonical, r));
}

/**
 * 造五个本地工具。fs / spawnFn / logger 均可注入以便离线单测。
 * @param {{ env?: NodeJS.ProcessEnv, fs?: object, spawnFn?: Function, logger?: {info?:Function,warn?:Function}, config?: object, selfRoot?: string }} [deps]
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
    info: (m) => { process.stderr.write(`[bridge-mcp] ${m}\n`); },
    warn: (m) => process.stderr.write(`[bridge-mcp] WARN ${m}\n`),
  };
  /**
   * 审计发射的**唯一**入口：既走 logger，也走落盘 sink。
   *
   * 0.5.1 把 `auditSink` 挂在**默认 logger** 的 `info` 里，于是任何注入了 logger 的调用方
   * 都会静默丢掉落盘审计——而审计是这条链路对外宣称的唯一补偿性控制（网页侧无人在环），
   * 它不该因为依赖注入方式不同而消失。0.5.2 起审计与 logger 解耦：无论 logger 是否被注入，
   * 只要设了 `DSH_BRIDGE_AUDIT_FILE` 就一定落盘。
   *
   * 所有 AUDIT 行必须经此函数发出，不要再直接调 `logger.info`（那会重新丢掉落盘）。
   */
  const audit = (line) => {
    logger.info(line);
    auditSink(line);
  };
  // 自身包根：默认按本模块位置推出（`<pkg>/src/local-fs.mjs` 上溯两级）；可注入以便单测
  // 断言写保护边界，而不必去动真实包目录。
  const selfRoot = deps.selfRoot ?? selfPackageRoot();
  const guard = (p, op) => guardPath(p, { env, op, selfRoot, auditFile: config.auditFile });
  // 递归遍历的逐条目守卫（不抛错，返回 null 即跳过）。0.5.1 修复：0.5.0 只在根上 guard，
  // walk 内部对发现的文件从不检查，于是一次 local_grep(path=父目录) 就能读出
  // ~/.dsh/task-bridge-token、.env、*.pem 的原文——三层保护形同虚设，且零测试覆盖。
  const guardEntry = (p) => guardWalkEntry(p, { env });

  // local_exec 并发计数（0.5.2）。递增/递减与检查都在同步代码里完成，JS 单线程下
  // 「检查 → 占位」之间不可能插入另一次调用，所以不需要锁。
  let execInFlight = 0;

  // 平台与信号发送函数可注入（0.5.2）。
  //
  // 为什么要这个 seam：POSIX 的进程组终止分支（detached:true + kill(-pid)）在 Windows 上
  // 是**死代码**，而本机装不了 WSL 分发版去实测它——`wsl.exe -l -v` 返回「没有已安装的分发版」。
  // 0.5.1 只对它做了代码审查就写进了发布说明，那属于「未验证却读起来像已验证」。
  // 有了 seam，至少能把**代码路径**钉住：用的是 `-pid`（进程组）而不是 `pid`、信号是 SIGKILL、
  // 兜底 kill 仍然执行、detached 确实传给了 spawn。这把「未测死代码」降级为
  // 「分支已测、Linux 内核语义仍未验证」——后者是可以如实写进文档的。
  const platform = deps.platform ?? process.platform;
  const killFn = deps.killFn ?? ((pid, signal) => process.kill(pid, signal));

  // 解除保护时留强告警：这些是不可逆的风险放大，必须在日志里可见。
  if (config.fsEnabled && !config.denyCredentials) {
    logger.warn('DSH_BRIDGE_FS_DENY_CREDENTIALS=0 —— 默认凭据保护已解除：网页会话可读取 ~/.ssh、~/.codex/auth.json、~/.config/gh/hosts.yml、~/.docker/config.json、.env、私钥、shell history、浏览器密码库等。仅在你明确知道后果时保留此设置。');
  }
  if (config.fsEnabled && env.DSH_BRIDGE_FS_ALLOW_SELF_WRITE === '1') {
    logger.warn('DSH_BRIDGE_FS_ALLOW_SELF_WRITE=1 —— 自身完整性保护已解除：网页会话可改写 bridge-mcp 自己的源码，而生产 profile 直接跑工作树，改动会在下次进程重启后被原样加载（持久化通道）。');
  }
  // 白名单模式启动即声明生效范围：这是个**收窄**开关，操作者应当能在日志里确认它真的生效了，
  // 以及它拦不住什么（否则容易误以为设了白名单就等于安全）。
  if ((config.fsEnabled || config.execEnabled) && allowRoots(env)) {
    const roots = allowRoots(env);
    logger.info(`DSH_BRIDGE_FS_ALLOW 白名单已启用：文件工具与 local_exec 的 cwd 被限制在 ${roots.length} 个根目录内。注意两点——白名单不解除任何凭据保护（AND 关系），且它管不住 local_exec 命令里用绝对路径访问的文件（要真正收窄请只开 LOCAL_FS 不开 shell）。`);
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
      audit(`AUDIT local_write_file path=${auditField(abs)} mode=${mode} existed=${existed} previousSize=${previousSize} writtenBytes=${intendedBytes}`);

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

    /** 内容正则搜索（零依赖遍历，有文件数、深度与**墙上时间**三重上限）。 */
    grep(args = {}) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      if (!pattern.trim()) throw new LocalToolError('invalid-params', '参数 pattern 缺失或为空');
      const flags = args.caseInsensitive === true ? 'i' : '';
      // 主线程只编译一次用于**尽早报「正则不合法」**（编译是线性的，不会回溯）；
      // 真正执行匹配一律在 vm 里，因为只有那里能被 timeout 中断。
      try {
        // eslint-disable-next-line no-new -- 仅为验证 pattern 合法，不使用返回值
        new RegExp(pattern, flags);
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
      // ---- 0.5.2：正则执行的硬时间上界 ----
      // 一次 grep 一个 context，跨文件复用（实测复用后单次 runInContext 约 0.095ms，
      // 而 runInNewContext 约 0.43ms；2000 文件量级下差出近 1s）。
      const ctx = vm.createContext({ pattern, flags, onlyMatching, lines: [], maxHits: 1 });
      const budgetMs = config.grepTimeoutMs;
      const startedAt = Date.now();
      let regexMsUsed = 0;
      /** 灾难性回溯被 vm 中断（pattern 有问题）——与「树太大跑不完」是两种不同结论，分开报。 */
      let regexTimedOut = false;
      /** 整次调用的墙上时间预算耗尽（树太大 / 磁盘太慢）。 */
      let wallTimedOut = false;
      let skippedRegexTimeout = 0;
      /** 任一终止条件成立即停止遍历。 */
      const aborted = () => truncated || regexTimedOut || wallTimedOut;
      /** 剩余预算；不足一个合法 vm 时间片就算耗尽。 */
      const remainingBudget = () => budgetMs - (Date.now() - startedAt);
      // 静默漏报计数器（0.5.1）：0.5.0 把超限/二进制/受保护文件直接 continue，
      // 却仍把它们算进 filesScanned，于是「扫了 N 个文件、只有 1 处命中、truncated:false」
      // 无法区分"确实没有"与"被跳过了"。现在逐项如实报告。
      let skippedOversize = 0;
      let skippedBinary = 0;
      let skippedProtected = 0;
      let skippedUnreadable = 0;
      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

      /**
       * 在单个文件的文本里搜；命中上限由本函数置 `truncated`。
       *
       * **匹配循环跑在 vm context 里**（0.5.2）。这不是把 vm 当沙箱——Node 文档明确说 vm
       * 不是安全边界，我也没把它当边界用：脚本文本写死，不可信的 pattern/lines 只作为数据
       * 进 contextified sandbox。用 vm 只为它的 `timeout`，因为那是 Node 里**唯一能中断正在
       * 回溯的正则**的同步机制；`child_process`/worker 之外的手段都拦不住一次 `re.test()`。
       *
       * 实测依据（本机 Node v24.13.1，`.tmpfiles/redos-probe/`）：
       *  - `(a+)+$` 对 33 字符输入、`(x+x+)+y` 对 30 字符输入，原生跑过 15s 需外部 taskkill；
       *  - 同模式放进 `vm.runInContext(..., { timeout: 400 })`，402/404ms 抛
       *    `Script execution timed out`，抛错后**同一 context 与父进程 JS 均正常**；
       *  - 指数、多项式、交替重叠、global `exec` 循环四种形状都被成功中断。
       *
       * 不选 worker_threads 同样是实测结论：Worker 默认选项下子进程写的 stdout 会**原样出现在
       * 父进程 stdout 上**（与 `w.stdout` 管道捕获双重投递），而本进程的 stdout 就是 JSON-RPC
       * 信道——worker 路线会直接撞坏协议。
       */
      const scanText = (filePath, buf) => {
        const remaining = remainingBudget();
        if (remaining < MIN_VM_SLICE_MS) { wallTimedOut = true; return; }
        let raw;
        const t0 = Date.now();
        try {
          ctx.lines = buf.toString('utf8').split('\n');
          ctx.maxHits = Math.max(1, maxMatches - matches.length);
          raw = vm.runInContext(GREP_SCAN_SCRIPT, ctx, { timeout: remaining });
        } catch (error) {
          const msg = String(error?.message ?? error);
          if (/timed out/i.test(msg)) {
            // 中断的是**这一条正则**，不是整个搜索能力：置标志后停止遍历即可，
            // 灾难性 pattern 在后续任何文件上同样灾难，继续跑只是把预算烧光。
            regexTimedOut = true;
            skippedRegexTimeout += 1;
            return;
          }
          // pattern 已在主线程用同一构造验证过，走到这里说明是别的执行期问题
          throw new LocalToolError('invalid-params', `正则执行失败：${msg.slice(0, 200)}`);
        } finally {
          regexMsUsed += Date.now() - t0;
        }
        const parsed = JSON.parse(raw);
        for (const hit of parsed.hits) {
          matches.push({ path: filePath, line: hit[0], text: hit[1] });
        }
        if (parsed.hitCap) truncated = true;
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
        if (aborted()) return;
        // 墙上时间预算检查放在遍历侧，而不只放在 scanText 侧：一棵巨大的树可能一个文件都
        // 没扫（全是目录/超限/二进制），却已经把时间耗在 readdir 与 stat 上。
        if (remainingBudget() < MIN_VM_SLICE_MS) { wallTimedOut = true; return; }
        let names;
        try {
          names = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
          skippedUnreadable += 1;
          return;
        }
        for (const ent of names) {
          if (aborted()) return;
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
      const skippedTotal = skippedOversize + skippedBinary + skippedProtected + skippedUnreadable + skippedRegexTimeout;
      const elapsedMs = Date.now() - startedAt;
      // 超时与「有跳过」是两类不同结论，note 分开说；超时优先，因为它意味着结果可能严重不完整。
      const note = regexTimedOut
        ? `正则在 ${elapsedMs}ms 内未跑完，已被强制中断（预算 ${budgetMs}ms）——该 pattern 极可能存在灾难性回溯（如嵌套量词 (a+)+、重叠交替）。已停止后续遍历，结果严重不完整。请收紧 pattern（去掉嵌套量词、加锚点与字面前缀），或改用更具体的字符串；确需长预算可在启动 bridge-mcp 时设 DSH_BRIDGE_GREP_TIMEOUT_MS。`
        : wallTimedOut
          ? `整次搜索在 ${budgetMs}ms 预算内未跑完（已扫 ${filesScanned} 个文件），已停止遍历，结果不完整。请收窄 path 或调大 DSH_BRIDGE_GREP_TIMEOUT_MS。`
          : skippedTotal > 0
            ? `有 ${skippedTotal} 个文件/目录被跳过（超限 ${skippedOversize}、二进制 ${skippedBinary}、凭据保护 ${skippedProtected}、不可读 ${skippedUnreadable}、正则中断 ${skippedRegexTimeout}），结果不完整；调大 DSH_BRIDGE_FS_MAX_BYTES 或收窄 path 可改善`
            : null;
      return {
        ok: true, pattern, root, filesScanned, matchCount: matches.length,
        // truncated 覆盖「有文件被跳过」与「被时间预算截停」——否则调用方无法知道结果不完整
        truncated: truncated || skippedTotal > 0 || regexTimedOut || wallTimedOut,
        limitTruncated: truncated,
        depthLimited,
        regexTimedOut,
        wallTimedOut,
        elapsedMs,
        regexMs: regexMsUsed,
        grepTimeoutMs: budgetMs,
        skipped: {
          total: skippedTotal, oversize: skippedOversize, binary: skippedBinary,
          protected: skippedProtected, unreadable: skippedUnreadable, regexTimeout: skippedRegexTimeout,
        },
        ...(note ? { note } : {}),
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
      // 默认 cwd 也要过守卫（0.5.2）：0.5.1 只在 `args.cwd` 存在时 guard，于是
      // 「不传 cwd」直接成了绕过白名单与三级保护的后门——defaultCwd 原样用作子进程工作目录。
      const cwd = guard(args.cwd ?? config.defaultCwd, 'exec');
      const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
        ? Math.min(args.timeoutMs, config.execTimeoutMs)
        : config.execTimeoutMs;

      // 并发闸（0.5.2）：超限**立即报错**而不是排队。排队会让调用方以为命令在跑（实际
      // 什么都没发生），而且队列本身又是一个无界资源。这条闸的存在理由是同进程还服务着
      // 7 个桥工具——云端会话一次扇出几十条命令就能把本机与隧道一起拖垮。
      if (execInFlight >= config.execMaxConcurrent) {
        throw new LocalToolError(
          'exec-busy',
          `已有 ${execInFlight} 条命令在执行，达到并发上限 ${config.execMaxConcurrent}（启动时设 DSH_BRIDGE_EXEC_MAX_CONCURRENT 可调）。请等前一条结束再试，或改用 local_read_file/local_grep——读文件不需要 shell。`,
        );
      }

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
        // 并发占位：只在 spawn **成功之后**递增，所以 spawnImpl 同步抛出时不会有配不上对的
        // 递减；release 用 counted 幂等，close 与 exit 都触发 finish 也只归还一次。
        let counted = false;
        const release = () => { if (counted) { counted = false; execInFlight -= 1; } };

        const child = spawnImpl(command, {
          cwd,
          shell: true,           // Windows 必需（否则 .cmd 与内置命令不可用）；POSIX 上也让 `|`、`>`、`&&` 可用
          windowsHide: true,
          // detached 让子进程成为**新进程组的组长**，POSIX 上才能用 `process.kill(-pid)` 杀整棵树。
          // 0.5.0 没设它，`kill -9 -<child.pid>` 里的 child.pid 不是任何 PGID → ESRCH，孙进程成孤儿
          // 继续跑（正确性评审推断；本机无 POSIX 环境未实测）。Windows 上该选项无副作用。
          detached: platform !== 'win32',
          // 白名单 env（0.5.1）：全量继承会让一条 `node -e "console.log(process.env.TASK_BRIDGE_TOKEN)"`
          // 把桥 token 送进云端对话记录——评审双方独立实测，本机确有 MANA_API_KEY 等用户级秘密。
          env: buildExecEnv(envSource),
        });
        counted = true;
        execInFlight += 1;

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

          if (platform === 'win32') {
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
            // POSIX：detached:true 后 child.pid 即 PGID，用负号发信号给**整个进程组**，
            // 不依赖外部 /bin/kill 可执行文件（裁剪镜像里可能没有）。
            // ⚠️ 本机无 POSIX 环境，内核语义未实测；代码路径由注入 seam 的单测覆盖。
            try { killFn(-pid, 'SIGKILL'); } catch { /* ESRCH/EPERM：已退出或无权 */ }
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
          release(); // 归还并发额度：close 与 exit 都会走到这里，靠 settled 保证只归还一次
          if (timer) clearTimeout(timer);
          // 显式销毁 stdio 流：被 taskkill /T /F 终止的进程树仍可能留有管道句柄，
          // 不销毁则持有者（本进程）的 event loop 要等到句柄自然关闭——实测 500ms 的
          // 超时会让宿主进程多活满脚本的整个生命周期（30s 脚本 → 30s 悬挂）。
          // 常驻 server 上这表现为句柄泄漏，测试 runner 上表现为 duration 虚高。
          try { child.stdout?.destroy(); } catch { /* 已关闭 */ }
          try { child.stderr?.destroy(); } catch { /* 已关闭 */ }
          // 审计：记命令原文（命令不是秘密）；输出内容不记，可能含敏感数据
          audit(`AUDIT local_exec cwd=${auditField(cwd)} timeoutMs=${timeoutMs} exit=${result.exitCode} timedOut=${result.timedOut} command=${auditField(command)}`);
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
          '且没有人在环的确认闸门——提示注入可指挥它篡改仓库。建议只在 git 工作树内使用，写完立刻 git diff 复核。' +
          '拒绝写入的路径：本链路凭据（不可解除）、默认凭据保护范围（~/.ssh、.env、私钥、shell history 等，可显式解除）、' +
          'DSH_BRIDGE_FS_DENY 黑名单、bridge-mcp 自身包目录与审计日志文件（防持久化改写与销毁留痕）。' +
          '被拒时回执 code 为 credential-protected / path-denied / self-write-protected。',
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
          '自动跳过 node_modules/.git/dist/build/coverage 与隐藏目录、跳过二进制与超限大文件。' +
          '三重上界：文件数（DSH_BRIDGE_GREP_MAX_FILES）、深度（MAX_DEPTH）、整次墙上时间' +
          '（DSH_BRIDGE_GREP_TIMEOUT_MS，默认 10000）。回执含 filesScanned / truncated / skipped / ' +
          'regexTimedOut / wallTimedOut / elapsedMs。' +
          '⚠️ 避免嵌套量词与重叠交替（如 (a+)+、([a-z]|[a-z])*）——它们会灾难性回溯，' +
          '被时间预算强制中断时回执置 regexTimedOut=true 且结果严重不完整；请改用带字面前缀与锚点的收紧写法。' +
          '命中被截断时缩小 path 或收紧 pattern。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'JS 正则（注意 \\d 需写 \\\\d）；避免嵌套量词，会灾难性回溯' },
            path: { type: 'string', description: '目录或单个文件；缺省为 bridge-mcp 进程 cwd' },
            caseInsensitive: { type: 'boolean' },
            onlyMatching: { type: 'boolean', description: '只返回命中片段而非整行（片段亦截到 500 字符）' },
            limit: { type: 'number' },
          },
          required: ['pattern'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, pattern: { type: 'string' }, root: { type: 'string' },
            filesScanned: { type: 'number' }, matchCount: { type: 'number' },
            truncated: { type: 'boolean' }, limitTruncated: { type: 'boolean' },
            depthLimited: { type: 'boolean' },
            regexTimedOut: { type: 'boolean', description: '正则被时间预算强制中断（灾难性回溯）' },
            wallTimedOut: { type: 'boolean', description: '整次搜索超出时间预算' },
            elapsedMs: { type: 'number' }, regexMs: { type: 'number' }, grepTimeoutMs: { type: 'number' },
            skipped: { type: 'object' }, note: { type: 'string' }, matches: { type: 'array' },
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
        `同时在跑的命令数上限 DSH_BRIDGE_EXEC_MAX_CONCURRENT（默认 ${DEFAULT_EXEC_MAX_CONCURRENT}），超限立即返回 code=exec-busy 而不是排队——请等前一条结束，或改用 local_read_file/local_grep。` +
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
    lines.push('写文件纪律：local_write_file 会让云端会话直接改动磁盘且无人在环确认——只在用户明确授权的路径内写，写完主动提示用户 git diff 复核；不得写本链路凭据文件（会被拒绝），默认也拒绝 ~/.ssh、~/.codex/auth.json、~/.config/gh/hosts.yml、.env、私钥、shell history 类路径，并拒绝改写 bridge-mcp 自身包目录与审计日志文件（防持久化与销毁留痕）。被拒绝时不要换路径绕过，直接告诉用户被哪一层保护拦住、以及解除它的代价。');
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

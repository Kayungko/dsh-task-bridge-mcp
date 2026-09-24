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
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** read / exec 输出的默认字节上限（与桥 body 上限 256KB 同量级）。 */
export const DEFAULT_MAX_BYTES = 256 * 1024;
/** exec 默认超时（对齐 Codex tool_timeout_sec 默认 60s 的一半，留出 MCP 序列化余量）。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** grep 默认扫描文件数上限（零依赖遍历，必须有界，否则大目录会拖死）。 */
export const DEFAULT_GREP_MAX_FILES = 2_000;
/** grep 默认递归深度上限。 */
export const DEFAULT_GREP_MAX_DEPTH = 12;

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
 * 强制保护（**不可通过 env 解除**）：这条链路自己的凭据。
 *
 * 泄露它们等于链路被劫持，属自毁而非能力——网页 GPT 读走桥 token 后，凭据就永久留在
 * 云端对话记录里；读走 DSH 的 .credentials.yaml 则等于交出宿主模型凭据。所以这两个
 * 即使调用方显式要求「全盘不限」也拒绝，且拒绝理由不暴露文件内容。
 */
export function protectedAlways(env = process.env) {
  const home = homedir();
  const list = [
    join(home, '.dsh', 'task-bridge-token'),
    join(home, '.dsh', '.credentials.yaml'),
  ];
  const custom = env.TASK_BRIDGE_TOKEN_FILE;
  if (typeof custom === 'string' && custom.trim()) list.push(resolve(custom.trim()));
  return list.map((p) => resolve(p));
}

/**
 * 默认保护（可用 `DSH_BRIDGE_FS_DENY_CREDENTIALS=0` 解除，解除时启动打强告警）：
 * 与这条链路无关、但泄露后果灾难性的常见凭据位置。
 *
 * 用「目录前缀 + 文件名模式」两类匹配：目录前缀覆盖 SSH/云凭据整棵树，文件名模式覆盖
 * 散落在项目里的 .env / 私钥 / pem。
 */
export const PROTECTED_DIRS = ['.ssh', '.aws', '.azure', '.gnupg', '.kube'];
export const PROTECTED_NAME_PATTERNS = [
  /^\.env(\..+)?$/i,          // .env / .env.local / .env.production
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|p12|pfx|key)$/i,
  /(^|[^a-z])credentials?\.(json|ya?ml)$/i,
  /(^|[\\/.])(kubeconfig|netrc|_netrc|pgpass|npmrc|pypirc)$/i,
];

/** 判断一个绝对路径是否落在默认保护范围内。 */
export function isProtectedByDefault(absPath, home = homedir()) {
  const p = resolve(absPath);
  const homeResolved = resolve(home);
  for (const dir of PROTECTED_DIRS) {
    const root = join(homeResolved, dir);
    if (p === root || p.startsWith(root + sep)) return true;
  }
  const base = p.slice(p.lastIndexOf(sep) + 1);
  return PROTECTED_NAME_PATTERNS.some((re) => re.test(base));
}

/**
 * 统一的路径守卫：规范化 + NUL 拒绝 + 两级凭据保护 + 用户追加黑名单。
 * @returns {string} 规范化后的绝对路径
 */
export function guardPath(rawPath, { env = process.env, op = 'read', home = homedir() } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new LocalToolError('invalid-params', '参数 path 缺失或不是非空字符串');
  }
  if (rawPath.includes('\0')) {
    throw new LocalToolError('invalid-params', '路径不得包含 NUL 字节');
  }
  const abs = resolve(rawPath.trim());

  // 第一级：强制保护，不可解除
  for (const denied of protectedAlways(env)) {
    if (abs === denied) {
      throw new LocalToolError(
        'credential-protected',
        `拒绝${op === 'read' ? '读取' : '写入'}该路径：它是本链路的凭据文件，读走会让凭据永久留在云端对话记录里（等同自毁）。此项保护不可通过配置解除；如确需轮换该文件，请在本机手工操作。`,
      );
    }
  }

  // 第二级：默认保护，可显式解除（解除时 createLocalTools 已在启动期打过强告警）
  const denyCredentials = env.DSH_BRIDGE_FS_DENY_CREDENTIALS !== '0';
  if (denyCredentials && isProtectedByDefault(abs, home)) {
    throw new LocalToolError(
      'credential-protected',
      `拒绝${op === 'read' ? '读取' : '写入'}该路径：命中默认凭据保护（SSH/云凭据目录，或 .env/私钥/pem/credentials 类文件名）。如确需访问，启动 bridge-mcp 时设 DSH_BRIDGE_FS_DENY_CREDENTIALS=0 解除（会在日志留强告警），或用 DSH_BRIDGE_FS_DENY 精确管理黑名单。`,
    );
  }

  // 第三级：用户追加黑名单（分隔符用 path.delimiter，Windows 为 `;`）
  const extra = env.DSH_BRIDGE_FS_DENY;
  if (typeof extra === 'string' && extra.trim()) {
    for (const pattern of extra.split(delimiter).map((s) => s.trim()).filter(Boolean)) {
      const target = resolve(pattern);
      if (abs === target || abs.startsWith(target + sep)) {
        throw new LocalToolError('path-denied', `拒绝${op === 'read' ? '读取' : '写入'}该路径：命中 DSH_BRIDGE_FS_DENY 黑名单项 ${pattern}`);
      }
    }
  }
  return abs;
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
  };
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** 统计信息投影（各工具共用，避免把 stat 全量字段倒给模型）。 */
function statProjection(st) {
  return {
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
  const logger = deps.logger ?? {
    info: (m) => process.stderr.write(`[bridge-mcp] ${m}\n`),
    warn: (m) => process.stderr.write(`[bridge-mcp] WARN ${m}\n`),
  };
  const guard = (p, op) => guardPath(p, { env, op });

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
      try {
        const st = fsImpl.statSync(abs);
        existed = true;
        previousSize = st.size;
        if (st.isDirectory()) throw new LocalToolError('is-directory', `${abs} 是目录，不能写`);
      } catch (error) {
        if (error instanceof LocalToolError) throw error;
        existed = false;
      }
      const dir = dirname(abs);
      if (dir) fsImpl.mkdirSync(dir, { recursive: true });

      if (mode === 'append') fsImpl.appendFileSync(abs, args.content, 'utf8');
      else fsImpl.writeFileSync(abs, args.content, 'utf8');

      const st = fsImpl.statSync(abs);
      // 审计：写操作每次记录（路径 + 模式 + 字节数），绝不记录内容
      logger.info(`AUDIT local_write_file path=${abs} mode=${mode} existed=${existed} previousSize=${previousSize} newSize=${st.size}`);
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
      const maxEntries = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 500;
      const entries = [];
      let truncated = false;

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
          entries.push({
            path: full,
            name: ent.name,
            type: isDir ? 'dir' : ent.isSymbolicLink() ? 'symlink' : 'file',
          });
          if (recursive && isDir && depth < config.grepMaxDepth && !ent.name.startsWith('.')) walk(full, depth + 1);
        }
      };
      walk(abs, 0);
      return { ok: true, path: abs, recursive, count: entries.length, truncated, entries };
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
      const maxMatches = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 100;
      const onlyMatching = args.onlyMatching === true;
      const matches = [];
      let filesScanned = 0;
      let truncated = false;
      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

      const walk = (dir, depth) => {
        if (truncated) return;
        let names;
        try {
          names = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of names) {
          if (truncated) return;
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
            if (depth < config.grepMaxDepth) walk(full, depth + 1);
            continue;
          }
          if (!ent.isFile()) continue;
          if (filesScanned >= config.grepMaxFiles) { truncated = true; return; }
          filesScanned += 1;
          let st;
          try {
            st = fsImpl.statSync(full);
          } catch {
            continue;
          }
          if (st.size > config.maxBytes) continue; // 大文件跳过，不拖慢整次搜索
          let buf;
          try {
            buf = fsImpl.readFileSync(full);
          } catch {
            continue;
          }
          const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
          if (b.subarray(0, Math.min(b.length, 8192)).includes(0)) continue; // 二进制跳过
          const lines = b.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            if (!re.test(lines[i])) continue;
            re.lastIndex = 0;
            matches.push({
              path: full,
              line: i + 1,
              text: onlyMatching ? (lines[i].match(re) ?? [])[0] ?? '' : lines[i].slice(0, 500),
            });
            if (matches.length >= maxMatches) { truncated = true; return; }
          }
        }
      };

      let rootStat;
      try {
        rootStat = fsImpl.statSync(root);
      } catch {
        throw new LocalToolError('not-found', `搜索根不存在或不可读：${root}`);
      }
      if (rootStat.isFile()) {
        // 单文件模式：直接在它里面搜
        const text = fsImpl.readFileSync(root).toString('utf8');
        text.split('\n').forEach((l, i) => {
          if (re.test(l) && matches.length < maxMatches) {
            re.lastIndex = 0;
            matches.push({ path: root, line: i + 1, text: onlyMatching ? (l.match(re) ?? [])[0] ?? '' : l.slice(0, 500) });
          }
        });
      } else {
        walk(root, 0);
      }
      return { ok: true, pattern, root, filesScanned, matchCount: matches.length, truncated, matches };
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
        let killedByLimit = false;
        let timedOut = false;
        let settled = false;

        const child = spawnImpl(command, {
          cwd,
          shell: true,           // Windows 必需（否则 .cmd 与内置命令不可用）；POSIX 上也让 `|`、`>`、`&&` 可用
          windowsHide: true,
          env: { ...process.env },
        });

        /**
         * 杀整棵进程树。
         *
         * **不能依赖 spawn 的 `timeout` 选项，也不能只靠 `child.kill()`**——本机实测
         * （Windows，`shell:true`）：`child.kill('SIGKILL')` 只杀掉直接子进程（shell），
         * 孙进程（真正的命令）继续持有 stdout 管道，于是 `exit` 触发而 **`close` 永不触发**，
         * Promise 挂死到孙进程自己跑完（500ms 的超时实测变成 30s）。`taskkill /pid <pid>
         * /T /F` 能真正终止整棵树（实测杀掉 shell + 2 个孙进程，781ms 内 close）。
         *
         * 因此两手都要：treeKill 防进程泄漏，下方的 `exit` 兜底防 Promise 挂死。
         * taskkill 走**参数数组**而非命令串，避免多一层 shell 二次解析。
         */
        const treeKill = () => {
          if (child.pid === undefined || child.pid === null) return;
          if (process.platform === 'win32') {
            try {
              treeKillFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } catch { /* 无权或已退出，下面的 kill 兜底 */ }
          } else {
            // POSIX：负 pid 杀整个进程组（子进程未 setsid，与 shell 同组）
            try { treeKillFn('kill', ['-9', `-${child.pid}`], {}); } catch { /* 忽略 */ }
          }
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
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

        const buildResult = (exitCode, signal) => ({
          // 超时下退出码可能是任意值（被 taskkill /F 杀），以 timedOut 标志为准而非信号码
          ok: !timedOut && exitCode === 0,
          command,
          cwd,
          exitCode,
          signal: signal ?? null,
          timedOut,
          outputTruncated: killedByLimit,
          stdout: stdout.slice(0, config.maxBytes),
          stderr: stderr.slice(0, config.maxBytes),
          ...(timedOut
            ? { note: `命令超过 ${timeoutMs}ms 上限被终止（已杀整棵进程树）。需要更长时间请在启动 bridge-mcp 时设更大的 DSH_BRIDGE_EXEC_TIMEOUT_MS，或改用 local_read_file/local_grep 等专用工具。` }
            : exitCode === 0 ? {} : { note: `命令以退出码 ${exitCode} 结束${signal ? `（信号 ${signal}）` : ''}；超时上限 ${timeoutMs}ms` }),
        });

        const append = (which, chunk) => {
          const text = chunk.toString('utf8');
          if (which === 'out') stdout += text; else stderr += text;
          if (!killedByLimit && stdout.length + stderr.length > config.maxBytes) {
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
  const config = resolveLocalConfig(env);
  if (!config.fsEnabled && !config.execEnabled) return [];
  const impl = createLocalTools({ ...deps, config });
  const tools = [];

  if (config.fsEnabled) {
    tools.push(
      {
        name: 'local_read_file',
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

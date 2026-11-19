import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { WorkerError } from './errors.js';
import type { DshPatchMode } from './dsh-patch.js';
import { DEFAULT_PRICING, type PricingConfig } from './pricing.js';

const { version: packageVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

/** 任务执行后端：headless = 每任务一个进程；sdk = 长驻 `dsh --profile sdk`。 */
export type BackendKind = 'headless' | 'sdk' | 'kimi';

/** MCP 传输：stdio（本地 leader）/ http（Streamable HTTP，远程 leader）。 */
export type TransportKind = 'stdio' | 'http';

export interface HttpConfig {
  host: string;
  port: number;
  /** Bearer token；非回环地址必须设置。 */
  token: string;
}

export interface SdkRuntimeConfig {
  profile: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  idleMs: number;
  initTimeoutMs: number;
}

/** Kimi Code CLI（ACP 后端）配置：命令、参数、握手超时。 */
export interface KimiRuntimeConfig {
  /** kimi 可执行文件（在 PATH 上直接写 kimi）。 */
  command: string;
  /** 默认 ['acp']；启动 `kimi acp` 走 ACP over stdio。 */
  args: string[];
  initTimeoutMs: number;
  /** 进程池空闲回收时长（毫秒）：超过且无活跃会话则关掉进程。 */
  idleMs: number;
  /**
   * 「工具已完成、但会话迟迟不返回」的空转看守（毫秒）：超时则主动收尾并按已完成的工作判成功。
   * 0 = 关闭看守。用于对抗上游模型服务 500/长重试把已完成的任务判成取消。
   */
  idleAfterToolMs: number;
}

/** 如何拉起 DSH：`node <bin.js>` 最稳（绕开 Windows .cmd 的 spawn 问题）。 */
export interface DshEntry {
  command: string;
  args: string[];
  shell?: boolean;
  /** 该入口是怎么被确定的，写进 worker_describe 方便排障。 */
  source: string;
}

export interface WorkerConfig {
  name: string;
  version: string;
  /** 当前执行后端（headless / sdk）。 */
  backend: BackendKind;
  /** 长驻 SDK 后端配置。 */
  sdk: SdkRuntimeConfig;
  /** Kimi Code CLI（ACP）后端配置；与 sdk/headless 并存，按任务切换。 */
  kimi: KimiRuntimeConfig;
  /** MCP 传输方式。 */
  transport: TransportKind;
  /** HTTP 传输配置（transport=http 时生效）。 */
  http: HttpConfig;
  profile: string;
  dsh: DshEntry;
  dshHome: string;
  /** 本 worker 自己的数据根目录（tasks/audit/batches/idem 都在其下）。 */
  dataHome: string;
  tasksDir: string;
  defaultCwd?: string;
  allowedCwds: string[];
  defaultPermissionMode: PermissionMode | 'auto';
  defaultTimeoutMs: number;
  maxConcurrent: number;
  /** 同一 cwd 的并发任务上限（防止单项目占满并发）。 */
  maxConcurrentPerCwd: number;
  /** 是否启用 cwd 能力缓存（落盘，auto 模式据此选模式）。 */
  capabilityStore: boolean;
  /** cwd 能力缓存 TTL（毫秒）。 */
  capabilityTtlMs: number;
  /** 失败分类为后端崩溃/初始化失败时是否自动重试一次。 */
  retryTransient: boolean;
  /** ACL 失败时是否自动创建可写 worktree 代替全权升级。 */
  autoWorktree: boolean;
  /** 自动 worktree 的根目录。 */
  worktreeRoot: string;
  /** 观察到 ACL 失败后是否立即中止当前 attempt（不再等模型/超时自然结束，避免烧 token）。 */
  aclFailFast: boolean;
  /** ACL 降级是否允许升级 danger-full-access（发布给他人使用时建议关掉，默认保持兼容）。 */
  allowFullAccessFallback: boolean;
  /** 终态任务过期后是否自动清理 worktree（默认开）。 */
  worktreeCleanup: boolean;
  /** worktree 保留时长（毫秒），过期后由清理任务移除；0 = 不自动清理。 */
  worktreeTtlMs: number;
  /** 任务完成通知 webhook（POST JSON）。 */
  notifyWebhook?: string;
  /** 任务完成通知命令（带 WORKER_NOTIFY_JSON 环境变量）。 */
  notifyCmd?: string;
  /** 已结束任务保留时长（毫秒），超时自动清理。 */
  taskTtlMs: number;
  /** 内存/落盘保留的最大任务数，超出时先淘汰最老的已结束任务。 */
  maxTasks: number;
  /** 自动清理间隔（毫秒）。 */
  cleanupIntervalMs: number;
  /** 审计日志目录。 */
  auditDir: string;
  /** 批量任务元数据目录。 */
  batchDir: string;
  /** 单次批量提交的最大任务数。 */
  maxBatchTasks: number;
  /** 可选：OTLP/HTTP trace 导出端点（空 = 关闭）。 */
  otelEndpoint?: string;
  /** OTel service.name。 */
  otelServiceName: string;
  /** DSH 兼容补丁模式：启动时自动检测/修复 pwsh 编码前缀。 */
  dshPatch: DshPatchMode;
  /** workspace-write 沙箱 ACL 授权失败时的降级策略：read-only | off。 */
  aclFallback: 'read-only' | 'danger-full-access' | 'off';
  /** worker_status 长轮询单次等待上限（毫秒）。 */
  statusWaitMaxMs: number;
  /** 单任务 DSH token 预算（0 = 不限制）；超出后自动取消任务，防止失控烧额度。 */
  maxTaskTokens: number;
  maxResultChars: number;
  maxStatusEvents: number;
  /** worker_status 单次结构化载荷（JSON）的 UTF-8 字节上限。 */
  maxStatusPayloadBytes: number;
  /** 是否采集 git 证据（status/diff 摘要 + diff.patch）。 */
  evidenceGit: boolean;
  /** 是否向 worker_run 任务文本注入汇报协议页脚。 */
  reportProtocol: boolean;
  /** worker_status 默认 detail：summary（仅状态/异常）或 events（旧行为）。 */
  statusDetail: 'summary' | 'events';
  /** DeepSeek 单价与人民币汇率（仅用于费用估算展示）。 */
  pricing: PricingConfig;
  /** 幂等键有效期（毫秒）；0 = 永不自动过期。 */
  idemTtlMs: number;
  /** 幂等键索引落盘目录。 */
  idemDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const dshHome = resolve(env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
  // 本 worker 自己的数据根：不再寄生在 DSH 的 home 下（worker 现在是多执行体网关）
  const dataHome = resolve(env.WORKER_HOME?.trim() || join(homedir(), '.agent-worker-mcp'));
  const permissionMode = parsePermissionMode(env.WORKER_PERMISSION_MODE);
  // 允许列表两种写法：新配置 WORKER_ALLOWED_CWDS（`;` 分隔）优先；
  // 兼容本机在用版 bridge 的 WORKER_ALLOWED_ROOTS（按平台分隔符，POSIX `:` / Windows `;`）。
  const allowedCwdsRaw = env.WORKER_ALLOWED_CWDS?.trim()
    ? { raw: env.WORKER_ALLOWED_CWDS, sep: ';' }
    : env.WORKER_ALLOWED_ROOTS?.trim()
      ? { raw: env.WORKER_ALLOWED_ROOTS, sep: delimiter }
      : undefined;
  const allowedCwds = (allowedCwdsRaw?.raw ?? '')
    .split(allowedCwdsRaw?.sep ?? ';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => resolve(part));

  return {
    name: 'agent-worker-mcp',
    version: packageVersion,
    backend: parseBackendKind(env.WORKER_BACKEND),
    transport: env.WORKER_TRANSPORT?.trim() === 'http' ? 'http' : 'stdio',
    http: {
      host: env.WORKER_HTTP_HOST?.trim() || '127.0.0.1',
      port: readInt(env, 'WORKER_HTTP_PORT', 7391, 0, 65_535),
      token: env.WORKER_HTTP_TOKEN?.trim() || '',
    },
    sdk: {
      profile: env.WORKER_SDK_PROFILE?.trim() || 'sdk',
      provider: env.WORKER_SDK_PROVIDER?.trim() || 'deepseek-official',
      model: env.WORKER_SDK_MODEL?.trim() || 'deepseek-flash',
      ...(env.WORKER_SDK_REASONING_EFFORT?.trim()
        ? { reasoningEffort: env.WORKER_SDK_REASONING_EFFORT.trim() }
        : {}),
      ...(readOptionalInt(env, 'WORKER_SDK_MAX_TOKENS') !== undefined
        ? { maxTokens: readOptionalInt(env, 'WORKER_SDK_MAX_TOKENS') }
        : {}),
      idleMs: readInt(env, 'WORKER_SDK_IDLE_MIN', 10, 1, 240) * 60_000,
      initTimeoutMs: readInt(env, 'WORKER_SDK_INIT_TIMEOUT_S', 300, 10, 900) * 1_000,
    },
    kimi: {
      command: env.WORKER_KIMI_COMMAND?.trim() || 'kimi',
      args: env.WORKER_KIMI_ARGS?.trim() ? env.WORKER_KIMI_ARGS.trim().split(/\s+/) : ['acp'],
      initTimeoutMs: readInt(env, 'WORKER_KIMI_INIT_TIMEOUT_S', 60, 10, 900) * 1_000,
      idleMs: readInt(env, 'WORKER_KIMI_IDLE_MIN', 10, 1, 240) * 60_000,
      idleAfterToolMs: readInt(env, 'WORKER_KIMI_IDLE_AFTER_TOOL_S', 120, 0, 3_600) * 1_000,
    },
    profile: env.WORKER_PROFILE?.trim() || 'headless',
    dsh: resolveDshEntry(env),
    dshHome,
    dataHome,
    tasksDir: resolve(env.WORKER_TASKS_DIR?.trim() || join(dataHome, 'tasks')),
    defaultCwd: env.WORKER_DEFAULT_CWD?.trim() ? resolve(env.WORKER_DEFAULT_CWD.trim()) : undefined,
    allowedCwds,
    defaultPermissionMode: permissionMode,
    // 默认 1800s：本机在用版实测 900s 偏小（多个 900–1800s 任务被误杀）。
    defaultTimeoutMs: readInt(env, 'WORKER_TIMEOUT_S', 1_800, 5, 86_400) * 1000,
    maxConcurrent: readInt(env, 'WORKER_MAX_CONCURRENT', 2, 1, 8),
    maxConcurrentPerCwd: readInt(env, 'WORKER_MAX_CONCURRENT_PER_CWD', 1, 1, 8),
    capabilityStore: readBool(env, 'WORKER_CAPABILITY_CACHE', true),
    capabilityTtlMs: readInt(env, 'WORKER_CAPABILITY_TTL_H', 24, 1, 8_760) * 3_600_000,
    retryTransient: readBool(env, 'WORKER_RETRY_TRANSIENT', true),
    autoWorktree: readBool(env, 'WORKER_AUTO_WORKTREE', true),
    worktreeRoot: resolve(env.WORKER_WORKTREE_ROOT?.trim() || join(homedir(), 'dsh-worktrees')),
    aclFailFast: readBool(env, 'WORKER_ACL_FAIL_FAST', true),
    allowFullAccessFallback: readBool(env, 'WORKER_ALLOW_FULL_ACCESS_FALLBACK', true),
    worktreeCleanup: readBool(env, 'WORKER_WORKTREE_CLEANUP', true),
    worktreeTtlMs: readInt(env, 'WORKER_WORKTREE_TTL_MIN', 1_440, 1, 100_000) * 60_000,
    ...(env.WORKER_NOTIFY_WEBHOOK?.trim() ? { notifyWebhook: env.WORKER_NOTIFY_WEBHOOK.trim() } : {}),
    ...(env.WORKER_NOTIFY_CMD?.trim() ? { notifyCmd: env.WORKER_NOTIFY_CMD.trim() } : {}),
    taskTtlMs: readInt(env, 'WORKER_TASK_TTL_MIN', 1_440, 1, 100_000) * 60_000,
    maxTasks: readInt(env, 'WORKER_TASK_MAX', 500, 10, 100_000),
    cleanupIntervalMs: readInt(env, 'WORKER_CLEANUP_INTERVAL_MIN', 10, 1, 1_440) * 60_000,
    auditDir: resolve(env.WORKER_AUDIT_DIR?.trim() || join(dataHome, 'audit')),
    batchDir: resolve(env.WORKER_BATCH_DIR?.trim() || join(dataHome, 'batches')),
    maxBatchTasks: readInt(env, 'WORKER_BATCH_MAX', 8, 1, 32),
    ...(env.WORKER_OTEL_ENDPOINT?.trim() ? { otelEndpoint: env.WORKER_OTEL_ENDPOINT.trim() } : {}),
    otelServiceName: env.WORKER_OTEL_SERVICE?.trim() || 'agent-worker-mcp',
    dshPatch: parseDshPatchMode(env.WORKER_DSH_PATCH),
    aclFallback: parseAclFallback(env.WORKER_ACL_FALLBACK),
    statusWaitMaxMs: readInt(env, 'WORKER_STATUS_WAIT_MAX_S', 120, 5, 600) * 1_000,
    maxTaskTokens: readInt(env, 'WORKER_MAX_TASK_TOKENS', 0, 0, 1_000_000_000),
    maxResultChars: readInt(env, 'WORKER_MAX_RESULT_CHARS', 40_000, 1_000, 1_000_000),
    maxStatusEvents: readInt(env, 'WORKER_MAX_STATUS_EVENTS', 100, 1, 1_000),
    maxStatusPayloadBytes: readInt(env, 'WORKER_MAX_STATUS_PAYLOAD_BYTES', 16_384, 4_096, 1_000_000),
    evidenceGit: readBool(env, 'WORKER_EVIDENCE_GIT', true),
    reportProtocol: readBool(env, 'WORKER_REPORT_PROTOCOL', true),
    statusDetail: parseStatusDetail(env.WORKER_STATUS_DETAIL),
    pricing: {
      inputPerMTok: readNumber(env, 'WORKER_PRICE_INPUT_PER_MTOK', DEFAULT_PRICING.inputPerMTok),
      cacheReadPerMTok: readNumber(env, 'WORKER_PRICE_CACHE_READ_PER_MTOK', DEFAULT_PRICING.cacheReadPerMTok),
      outputPerMTok: readNumber(env, 'WORKER_PRICE_OUTPUT_PER_MTOK', DEFAULT_PRICING.outputPerMTok),
      usdCny: readNumber(env, 'WORKER_USD_CNY', DEFAULT_PRICING.usdCny),
    },
    idemTtlMs: readInt(env, 'WORKER_IDEM_TTL_H', 24, 0, 8_760) * 3_600_000,
    idemDir: resolve(env.WORKER_IDEM_DIR?.trim() || join(dataHome, 'idem')),
  };
}

/** WORKER_BACKEND：sdk（默认）/ headless / kimi；未知值按 sdk 处理。 */
export function parseBackendKind(value: string | undefined): BackendKind {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'headless' || normalized === 'kimi') return normalized;
  return 'sdk';
}

function parseStatusDetail(value: string | undefined): 'summary' | 'events' {
  return value?.trim().toLowerCase() === 'events' ? 'events' : 'summary';
}

/** 探测本机 DSH 入口；优先级：显式 CLI 路径 > 显式命令 > 已知安装路径 > PATH 上的 dsh。 */
export function resolveDshEntry(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): DshEntry {
  const cli = env.WORKER_DSH_CLI?.trim();
  if (cli) {
    return { command: process.execPath, args: [resolve(cli)], source: 'env:WORKER_DSH_CLI' };
  }
  const rawCommand = env.WORKER_DSH_COMMAND?.trim();
  if (rawCommand) {
    return { command: rawCommand, args: [], shell: true, source: 'env:WORKER_DSH_COMMAND' };
  }

  const candidates: string[] = [];
  const dir = env.WORKER_DSH_DIR?.trim();
  if (dir) candidates.push(join(resolve(dir), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { command: process.execPath, args: [candidate], source: `auto:${candidate}` };
    }
  }
  return { command: 'dsh', args: [], shell: true, source: 'PATH(dsh)' };
}

/**
 * 校验并规范化 cwd。
 * 拒绝：不存在、非目录、用户主目录、用户主目录的祖先目录（Windows ACL 沙箱会因此让 shell 工具不可用）。
 */
export function validateCwd(input: string, config: WorkerConfig): string {
  const resolved = resolve(input);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new WorkerError('invalid_cwd', `cwd 不存在：${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new WorkerError('invalid_cwd', `cwd 不是目录：${resolved}`);
  }

  const home = resolve(homedir());
  // Windows 沙箱下 temp 根会落在工作区内，导致 shell 工具不可用，所以拒绝主目录与其祖先；
  // macOS/Linux 无此限制（本机在用版 bridge 一直允许 home 作为 cwd，合并时对齐平台差异）。
  if (process.platform === 'win32' && samePath(resolved, home)) {
    throw new WorkerError(
      'invalid_cwd',
      `cwd 不能是用户主目录（${home}）：Windows 沙箱下 temp 根会落在工作区内，导致 shell 工具不可用。请传入具体项目目录。`,
    );
  }
  if (process.platform === 'win32' && samePath(home, resolved) === false && isUnderRoot(home, resolved)) {
    throw new WorkerError('invalid_cwd', `cwd 不能是用户主目录的祖先目录（${resolved}），请传入具体项目目录。`);
  }

  if (config.allowedCwds.length > 0 && !config.allowedCwds.some((root) => isUnderRoot(resolved, root))) {
    throw new WorkerError(
      'invalid_cwd',
      `cwd 不在允许列表内：${resolved}（允许：${config.allowedCwds.join('; ')}）`,
    );
  }
  return resolved;
}

function parseDshPatchMode(value: string | undefined): DshPatchMode {
  const raw = value?.trim();
  if (raw === 'off' || raw === 'notify' || raw === 'apply') return raw;
  return 'apply';
}

function parseAclFallback(value: string | undefined): 'read-only' | 'danger-full-access' | 'off' {
  const raw = value?.trim();
  if (raw === 'off') return 'off';
  if (raw === 'read-only') return 'read-only';
  // 默认 B 方案：workspace-write 遇 ACL 授权失败时自动升级 danger-full-access 重试
  return 'danger-full-access';
}

function parsePermissionMode(value: string | undefined): PermissionMode | 'auto' {
  const raw = value?.trim();
  if (!raw) return 'auto';
  if (raw === 'auto') return 'auto';
  if ((PERMISSION_MODES as string[]).includes(raw)) return raw as PermissionMode;
  return 'auto';
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function readOptionalInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

/** 读取非负浮点数（单价/汇率这类允许小数的配置）。 */
function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function isUnderRoot(child: string, root: string): boolean {
  const childNormalized = normalizeForCompare(child);
  const rootNormalized = normalizeForCompare(root);
  return childNormalized === rootNormalized || childNormalized.startsWith(`${rootNormalized}${sep}`);
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function normalizeForCompare(value: string): string {
  const resolved = resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}















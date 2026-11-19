import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { WorkerError } from './errors.js';

/**
 * TOML 路径 → 环境变量名。
 *
 * 设计：配置文件是**主配置面**，env 只做覆盖。加载时把 TOML 展平成与 env 同构的
 * 扁平键，因此下游全部沿用既有的读取/校验逻辑，两者不会各写一套。
 */
const FIELD_MAP: Record<string, string> = {
  backend: 'WORKER_BACKEND',
  transport: 'WORKER_TRANSPORT',

  'http.host': 'WORKER_HTTP_HOST',
  'http.port': 'WORKER_HTTP_PORT',
  'http.token': 'WORKER_HTTP_TOKEN',

  'backends.dsh.profile': 'WORKER_SDK_PROFILE',
  'backends.dsh.provider': 'WORKER_SDK_PROVIDER',
  'backends.dsh.model': 'WORKER_SDK_MODEL',
  'backends.dsh.reasoning_effort': 'WORKER_SDK_REASONING_EFFORT',
  'backends.dsh.max_tokens': 'WORKER_SDK_MAX_TOKENS',
  'backends.dsh.idle_min': 'WORKER_SDK_IDLE_MIN',
  'backends.dsh.init_timeout_s': 'WORKER_SDK_INIT_TIMEOUT_S',
  'backends.dsh.headless_profile': 'WORKER_PROFILE',

  'backends.kimi.command': 'WORKER_KIMI_COMMAND',
  'backends.kimi.args': 'WORKER_KIMI_ARGS',
  'backends.kimi.model': 'WORKER_KIMI_MODEL',
  'backends.kimi.effort': 'WORKER_KIMI_EFFORT',
  'backends.kimi.init_timeout_s': 'WORKER_KIMI_INIT_TIMEOUT_S',
  'backends.kimi.idle_min': 'WORKER_KIMI_IDLE_MIN',
  'backends.kimi.idle_after_tool_s': 'WORKER_KIMI_IDLE_AFTER_TOOL_S',

  'dsh.cli': 'WORKER_DSH_CLI',
  'dsh.command': 'WORKER_DSH_COMMAND',
  'dsh.dir': 'WORKER_DSH_DIR',
  'dsh.patch': 'WORKER_DSH_PATCH',

  'paths.home': 'WORKER_HOME',
  'paths.tasks': 'WORKER_TASKS_DIR',
  'paths.audit': 'WORKER_AUDIT_DIR',
  'paths.batches': 'WORKER_BATCH_DIR',
  'paths.idem': 'WORKER_IDEM_DIR',
  'paths.worktrees': 'WORKER_WORKTREE_ROOT',
  'paths.default_cwd': 'WORKER_DEFAULT_CWD',

  'limits.max_concurrent': 'WORKER_MAX_CONCURRENT',
  'limits.max_concurrent_per_cwd': 'WORKER_MAX_CONCURRENT_PER_CWD',
  'limits.timeout_s': 'WORKER_TIMEOUT_S',
  'limits.max_task_tokens': 'WORKER_MAX_TASK_TOKENS',
  'limits.status_wait_max_s': 'WORKER_STATUS_WAIT_MAX_S',

  'output.max_result_chars': 'WORKER_MAX_RESULT_CHARS',
  'output.max_status_events': 'WORKER_MAX_STATUS_EVENTS',
  'output.max_status_payload_bytes': 'WORKER_MAX_STATUS_PAYLOAD_BYTES',
  'output.status_detail': 'WORKER_STATUS_DETAIL',

  'retention.task_ttl_min': 'WORKER_TASK_TTL_MIN',
  'retention.task_max': 'WORKER_TASK_MAX',
  'retention.cleanup_interval_min': 'WORKER_CLEANUP_INTERVAL_MIN',
  'retention.idem_ttl_h': 'WORKER_IDEM_TTL_H',
  'retention.batch_max': 'WORKER_BATCH_MAX',

  'permissions.mode': 'WORKER_PERMISSION_MODE',
  'permissions.allowed_cwds': 'WORKER_ALLOWED_CWDS',
  'permissions.acl_fallback': 'WORKER_ACL_FALLBACK',
  'permissions.acl_fail_fast': 'WORKER_ACL_FAIL_FAST',
  'permissions.allow_full_access_fallback': 'WORKER_ALLOW_FULL_ACCESS_FALLBACK',

  'behavior.evidence_git': 'WORKER_EVIDENCE_GIT',
  'behavior.report_protocol': 'WORKER_REPORT_PROTOCOL',
  'behavior.retry_transient': 'WORKER_RETRY_TRANSIENT',
  'behavior.auto_worktree': 'WORKER_AUTO_WORKTREE',
  'behavior.worktree_cleanup': 'WORKER_WORKTREE_CLEANUP',
  'behavior.worktree_ttl_min': 'WORKER_WORKTREE_TTL_MIN',
  'behavior.capability_cache': 'WORKER_CAPABILITY_CACHE',
  'behavior.capability_ttl_h': 'WORKER_CAPABILITY_TTL_H',

  'pricing.input_per_mtok': 'WORKER_PRICE_INPUT_PER_MTOK',
  'pricing.cache_read_per_mtok': 'WORKER_PRICE_CACHE_READ_PER_MTOK',
  'pricing.output_per_mtok': 'WORKER_PRICE_OUTPUT_PER_MTOK',
  'pricing.usd_cny': 'WORKER_USD_CNY',

  'observability.otel_endpoint': 'WORKER_OTEL_ENDPOINT',
  'observability.otel_service': 'WORKER_OTEL_SERVICE',

  'notify.webhook': 'WORKER_NOTIFY_WEBHOOK',
  'notify.cmd': 'WORKER_NOTIFY_CMD',
};

/** 这两个字段在 env 里用列表分隔符拼接，配置文件里写数组。 */
const ARRAY_FIELDS = new Set(['permissions.allowed_cwds', 'backends.kimi.args']);

export interface LoadedConfigFile {
  path: string;
  /** 展平成与 env 同构的键值，供 loadConfig 与 env 合并（env 优先）。 */
  values: Record<string, string>;
  /** 文件里出现但 schema 不认识的键——必须报错，否则「配了没生效」无从察觉。 */
  unknownKeys: string[];
}

/** 配置文件位置：WORKER_CONFIG 显式指定 > 默认路径（存在才用）。 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.WORKER_CONFIG?.trim();
  if (explicit) return resolve(explicit);
  const fallback = join(homedir(), '.agent-worker-mcp', 'config.toml');
  return existsSync(fallback) ? fallback : undefined;
}

export function loadConfigFile(path: string): LoadedConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new WorkerError(
      'bad_request',
      `读取配置文件失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new WorkerError(
      'bad_request',
      `配置文件不是合法 TOML：${path}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const flat = flatten(parsed);
  const values: Record<string, string> = {};
  const unknownKeys: string[] = [];

  for (const [tomlPath, value] of flat) {
    const envKey = FIELD_MAP[tomlPath];
    if (!envKey) {
      unknownKeys.push(tomlPath);
      continue;
    }
    const converted = toEnvValue(value, tomlPath);
    if (converted !== undefined) values[envKey] = converted;
  }

  return { path, values, unknownKeys };
}

function flatten(input: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function toEnvValue(value: unknown, tomlPath: string): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) {
    if (!ARRAY_FIELDS.has(tomlPath)) {
      throw new WorkerError('bad_request', `配置项 ${tomlPath} 不支持数组`);
    }
    const separator = tomlPath === 'permissions.allowed_cwds' ? ';' : ' ';
    return value.map((item) => String(item)).join(separator);
  }
  return undefined;
}

/** 供 worker_describe 与启动日志使用：暴露 schema 的全部可配置路径。 */
export function configSchemaPaths(): string[] {
  return Object.keys(FIELD_MAP);
}

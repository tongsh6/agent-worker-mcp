import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface TemplateOverrides {
  /** Kimi 默认模型（写入生效值而不是注释）。 */
  kimiModel?: string;
  /** 自动 worktree 根目录。 */
  worktrees?: string;
}

/**
 * 生成配置模板：**可配置项写全、逐项注释、默认只保留最简单的活跃项**。
 *
 * 目标：用户打开这个文件就能看懂全部选项，不必去翻文档或再跑 `worker_describe`。
 * 未注释的行是当前生效值；注释行给出默认行为，需要时取消注释即可。
 */
export function buildConfigTemplate(overrides: TemplateOverrides = {}): string {
  const kimiModel = overrides.kimiModel ?? 'kimi-code/k3';
  const worktrees = overrides.worktrees;
  return `# agent-worker-mcp 配置（主配置面）
#
# 优先级：环境变量 > 本文件 > 内置默认。env 只用于覆盖（CI / 临时调试）。
# 改完需重启 leader 会话（MCP server 按会话拉起）。
# 配错会启动失败并列出问题项；全部可配置路径见 worker_describe 的 config.schema_paths。
#
# 约定：未注释 = 当前生效；注释掉 = 默认行为，需要时取消注释即可。

# ── 默认执行体 ────────────────────────────────────────────────
backend = "dsh"                    # dsh | kimi；worker_run 可用 backend 参数单次覆盖
# transport = "stdio"              # stdio | http（远程 leader 用 http）

# ── HTTP 传输（transport = "http" 时生效）────────────────────
# [http]
# host = "127.0.0.1"               # 监听地址；0.0.0.0 时必须设 token
# port = 7391
# token = ""                       # Bearer token；非回环地址必填

# ── DSH 执行器 ────────────────────────────────────────────────
[backends.dsh]
model = "deepseek-flash"
# provider = "deepseek-official"
# reasoning_effort = "high"        # low | high | max；留空 = 模型默认
# max_tokens = 0                   # 单次输出 token 上限；0 = 不限制
# idle_min = 10                    # 后端进程空闲回收（分钟）
# init_timeout_s = 300             # 握手超时（秒）；失败自动重试 1 次后降级 headless
# headless_profile = "headless"    # 降级 headless 时使用的 DSH profile
# profile = "sdk"                  # SDK 长驻后端使用的 DSH profile

# ── Kimi 执行器 ───────────────────────────────────────────────
[backends.kimi]
model = "${kimiModel}"
# effort = "low"                   # low | high | max；留空 = 模型默认（k3 系为 high）
# command = "kimi"                 # Kimi Code CLI 可执行文件
# args = ["acp"]                   # 启动参数（ACP over stdio）
# init_timeout_s = 60              # ACP 握手超时（秒）
# idle_min = 10                    # 进程池空闲回收（分钟）
# idle_after_tool_s = 120          # 工具完成后无事件多久主动收尾；0 = 关闭

# ── DSH 入口探测（通常不用改）────────────────────────────────
# [dsh]
# cli = ""                         # @deepseek-ai/dsh/lib/bin.js 绝对路径（最稳）
# command = ""                     # 完整命令（如 dsh）；优先级低于 cli
# dir = ""                         # DSH 安装目录
# patch = "apply"                  # apply | notify | off：DSH 兼容补丁

# ── 路径 ──────────────────────────────────────────────────────
[paths]
${worktrees ? `worktrees = "${worktrees}"` : '# worktrees = "D:/work/worktrees/dsh"'}  # 自动 worktree 的根目录
# home = "~/.agent-worker-mcp"     # 数据根（tasks/audit/batches/idem 都在其下）
# tasks = "tasks"
# audit = "audit"
# batches = "batches"
# idem = "idem"
# default_cwd = ""                 # 省略 cwd 时使用的默认目录

# ── 并发与超时 ────────────────────────────────────────────────
[limits]
# max_concurrent = 2               # 全局并发上限（1–8）
# max_concurrent_per_cwd = 1       # 同一 git 仓库并发上限（防冲突）
# timeout_s = 1800                 # 单任务超时（秒）
# max_task_tokens = 0              # 单任务 token 预算；0 = 不限制
# status_wait_max_s = 120          # worker_status 单次长轮询上限（秒）

# ── 结果与状态展示 ────────────────────────────────────────────
[output]
# max_result_chars = 40000         # 结果输出截断长度
# max_status_events = 100          # 状态里最多保留的事件数
# max_status_payload_bytes = 16384 # 状态负载上限（字节）
# status_detail = "summary"        # summary | events（events = 返回全部事件）

# ── 保留与清理 ────────────────────────────────────────────────
[retention]
# task_ttl_min = 1440              # 已结束任务保留（分钟）
# task_max = 500                   # 任务数上限；超额淘汰最老的已结束任务
# cleanup_interval_min = 10        # 自动清理间隔（分钟）
# idem_ttl_h = 24                  # 幂等索引 TTL（小时）
# batch_max = 8                    # 单次批量提交的任务数上限

# ── 权限 ──────────────────────────────────────────────────────
[permissions]
# mode = "auto"                    # auto | read-only | workspace-write | danger-full-access
# allowed_cwds = []                # cwd 白名单；空 = 不限制
# acl_fallback = "danger-full-access"  # workspace-write ACL 失败后的目标模式
# acl_fail_fast = true             # 首条命令 ACL 失败即中止当前 attempt
# allow_full_access_fallback = true    # 是否允许自动升级危险模式（发布给别人建议 false）

# ── 行为 ──────────────────────────────────────────────────────
[behavior]
# evidence_git = true              # 采集 git 变更证据
# report_protocol = true           # 要求标准结果协议
# retry_transient = true           # 瞬时失败自动重试
# auto_worktree = true             # 非 git 目录 / ACL 失败时自动建 worktree
# worktree_cleanup = true
# worktree_ttl_min = 1440
# capability_cache = true          # 缓存能力探测结果
# capability_ttl_h = 24

# ── 定价（费用估算）───────────────────────────────────────────
[pricing]
# input_per_mtok = 0.28            # 输入 $/百万 token
# cache_read_per_mtok = 0.028
# output_per_mtok = 0.42
# usd_cny = 6.65

# ── 观测 ──────────────────────────────────────────────────────
# [observability]
# otel_endpoint = ""               # OTLP/HTTP traces；空 = 关闭
# otel_service = "agent-worker-mcp"

# ── 通知 ──────────────────────────────────────────────────────
# [notify]
# webhook = ""
# cmd = ""
`;
}

/** 默认数据根：WORKER_HOME > ~/.agent-worker-mcp。 */
export function defaultDataHome(): string {
  const custom = process.env.WORKER_HOME?.trim();
  return custom ? resolve(custom) : join(homedir(), '.agent-worker-mcp');
}

/**
 * 首次启动生成配置模板（已存在则不动）。
 * 返回生成的文件路径；文件已存在时返回 undefined。
 */
export function ensureConfigTemplate(home = defaultDataHome(), overrides: TemplateOverrides = {}): string | undefined {
  const file = join(home, 'config.toml');
  if (existsSync(file)) return undefined;
  mkdirSync(home, { recursive: true });
  writeFileSync(file, buildConfigTemplate(overrides), 'utf8');
  return file;
}

import { KimiAcpBackend, type KimiSpawnOptions } from './kimi-acp-backend.js';

export interface KimiPoolOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  initTimeoutMs: number;
  /** 空闲超过该时长回收进程。 */
  idleMs: number;
  sweepIntervalMs?: number;
  now?: () => number;
  /** 测试注入点：默认真实拉起 `kimi acp`。 */
  createBackend?: (options: KimiSpawnOptions) => Promise<KimiAcpBackend>;
}

interface PoolEntry {
  promise: Promise<KimiAcpBackend>;
  backend?: KimiAcpBackend;
}

/** Windows 路径大小写不敏感；去掉尾部分隔符，避免同一目录被算成两个 key。 */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * 按 cwd 缓存 `kimi acp` 进程：同一项目复用同一个进程，进程内按会话并发。
 * 空闲且没有活跃会话时回收；后端被判定不健康（取消超时）时不再分配，交给下一任务重建。
 */
export class KimiBackendPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: KimiPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    const interval = options.sweepIntervalMs ?? Math.max(30_000, Math.min(60_000, options.idleMs));
    this.sweeper = setInterval(() => this.sweep(), interval);
    this.sweeper.unref?.();
  }

  async acquire(cwd: string, permissionMode?: string): Promise<KimiAcpBackend> {
    const key = normalizeCwd(cwd);
    const existing = this.entries.get(key);
    if (existing) {
      const backend = await existing.promise.catch(() => undefined);
      if (backend && !backend.isClosed && !backend.isUnhealthy) return backend;
      if (this.entries.get(key) === existing) this.entries.delete(key);
      if (backend) void backend.close();
    }

    const create = this.options.createBackend ?? KimiAcpBackend.start;
    const entry: PoolEntry = {
      promise: create({
        command: this.options.command,
        args: this.options.args,
        cwd,
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        initTimeoutMs: this.options.initTimeoutMs,
      }),
    };
    this.entries.set(key, entry);
    try {
      const backend = await entry.promise;
      entry.backend = backend;
      return backend;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  /** 后端整体不可用（崩溃/取消超时）：从池中移除并关闭，下个任务重建。 */
  evict(backend: KimiAcpBackend): void {
    for (const [key, entry] of this.entries) {
      if (entry.backend === backend) this.entries.delete(key);
    }
    void backend.close();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        const backend = await entry.promise.catch(() => undefined);
        if (backend) await backend.close();
      }),
    );
  }

  stats(): { processes: number; activeSessions: number; idleMs: number } {
    let processes = 0;
    let activeSessions = 0;
    for (const entry of this.entries.values()) {
      if (entry.backend && !entry.backend.isClosed) {
        processes += 1;
        activeSessions += entry.backend.activeSessions;
      }
    }
    return { processes, activeSessions, idleMs: this.options.idleMs };
  }

  private sweep(): void {
    for (const [key, entry] of this.entries) {
      const backend = entry.backend;
      if (!backend) continue;
      if (backend.isClosed || backend.isUnhealthy) {
        this.entries.delete(key);
        void backend.close();
        continue;
      }
      // 有会话在跑就不能回收，否则长任务会被误杀
      if (backend.busy) continue;
      if (this.now() - backend.lastUsed > this.options.idleMs) {
        this.entries.delete(key);
        void backend.close();
      }
    }
  }
}

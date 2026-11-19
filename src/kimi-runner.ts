import type { KimiAcpBackend } from './kimi-acp-backend.js';
import type { RunHandle, TaskRunner } from './task-manager.js';
import type { RunEvent, RunOutcome } from './types.js';

/** 池的最小契约：runner 只需要取后端与驱逐，便于测试替身。 */
export interface KimiBackendSource {
  acquire(cwd: string, permissionMode?: string): Promise<KimiAcpBackend>;
  evict(backend: KimiAcpBackend): void;
}

export interface KimiRunnerOptions {
  pool: KimiBackendSource;
}

/**
 * 用 `kimi acp` 实现 TaskRunner（进程由池复用，会话按任务创建或恢复）。
 * - 续聊：有 resumeSessionId 时先尝试 ACP session/load，失败则新建会话并显式记录降级；
 * - 取消走 ACP 原生 session/cancel，只影响本会话；
 * - 正常结束后进程留在池里，不重复支付冷启动。
 */
export function createKimiRunner(options: KimiRunnerOptions): TaskRunner {
  return (input): RunHandle => {
    const startedAt = Date.now();
    const events: RunEvent[] = [];
    let backend: KimiAcpBackend | null = null;
    let sessionId: string | null = null;
    let cancelled = false;
    let settled = false;
    let resolveOutcome!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const emit = (event: RunEvent): void => {
      events.push(event);
      input.onEvent(event);
    };

    const finish = (partial: Partial<RunOutcome>): void => {
      if (settled) return;
      settled = true;
      resolveOutcome({
        exitCode: 0,
        signal: null,
        finalText: null,
        sessionId,
        errorMessage: null,
        timedOut: false,
        cancelled: false,
        stderrTail: '',
        events,
        startedAt,
        endedAt: Date.now(),
        ...partial,
      });
    };

    void (async () => {
      try {
        backend = await options.pool.acquire(input.cwd, input.permissionMode);
        if (cancelled) {
          finish({ cancelled: true });
          return;
        }

        if (input.resumeSessionId) {
          try {
            await backend.loadSession(input.resumeSessionId, input.cwd, input.permissionMode);
            sessionId = input.resumeSessionId;
            emit({ type: 'status', phase: 'session_resumed', session_id: input.resumeSessionId });
          } catch (error) {
            emit({
              type: 'status',
              phase: 'session_resume_fallback',
              reason: 'load-failed',
              detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
            });
          }
        }
        if (!sessionId) sessionId = await backend.newSession(input.cwd, input.permissionMode);
        input.onEvent({ type: 'session', sessionId, cwd: input.cwd });
        if (cancelled) {
          backend.cancel(sessionId);
          finish({ cancelled: true });
          return;
        }

        const result = await backend.prompt(sessionId, input.task, emit, input.timeoutMs);
        // idle_after_tool：工具已执行完、会话因上游故障迟迟不返回，按已完成的工作收尾，不算失败
        const succeeded =
          result.reason === 'end_turn' || result.reason === 'completed' || result.reason === 'idle_after_tool';
        if (result.reason === 'idle_after_tool') {
          emit({
            type: 'status',
            phase: 'idle_after_tool',
            note: '工具已完成，但模型侧长时间无响应；按已完成的工作收尾（结果可能缺最后一段叙述）',
          });
        }
        finish({
          exitCode: succeeded ? 0 : 1,
          finalText: result.text,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          errorMessage: succeeded ? null : (result.error ?? `stopReason: ${String(result.reason)}`),
          stderrTail: backend.diagnostics,
        });
        if (backend.isUnhealthy || backend.isClosed) options.pool.evict(backend);
      } catch (error) {
        if (backend) options.pool.evict(backend);
        finish({
          exitCode: 1,
          errorMessage: error instanceof Error ? error.message : String(error),
          stderrTail: backend?.diagnostics ?? '',
        });
      }
    })();

    return {
      pid: null,
      cancel: () => {
        cancelled = true;
        if (backend) {
          backend.cancel(sessionId ?? undefined);
          return;
        }
        finish({ exitCode: null, cancelled: true });
      },
      outcome,
    };
  };
}

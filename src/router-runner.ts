import type { TaskRunner } from './task-manager.js';

/** 任务级执行后端：dsh = 当前 DSH 链（sdk/headless），kimi = Kimi Code CLI。 */
export type RunBackend = 'dsh' | 'kimi';

export interface RouterRunnerOptions {
  dsh: TaskRunner;
  kimi: TaskRunner;
  /** 未显式指定 backend 时用哪个（来自 DSH_MCP_BACKEND）。 */
  defaultKind: RunBackend;
}

export const RUN_BACKENDS: RunBackend[] = ['dsh', 'kimi'];

/**
 * 按任务选择执行体：dsh_run(backend) > 全局默认。
 * 「随时切换」的关键就在这一层——两个后端都常驻可用，不互相替换。
 */
export function createRouterRunner(options: RouterRunnerOptions): TaskRunner {
  return (input) => {
    const kind: RunBackend =
      input.backend === 'dsh' || input.backend === 'kimi' ? input.backend : options.defaultKind;
    return kind === 'kimi' ? options.kimi(input) : options.dsh(input);
  };
}

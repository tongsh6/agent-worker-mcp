import { describe, expect, it } from 'vitest';
import { createKimiRunner, type KimiBackendSource } from '../src/kimi-runner.js';
import type { RunEvent } from '../src/types.js';
import { waitFor } from './helpers.js';

function makeBackend(options: { loadFails?: boolean } = {}) {
  const calls: Array<[string, string?]> = [];
  const backend = {
    isClosed: false,
    isUnhealthy: false,
    diagnostics: '',
    async loadSession(sessionId: string) {
      calls.push(['load', sessionId]);
      if (options.loadFails) throw new Error('session 不存在');
    },
    async newSession() {
      calls.push(['new']);
      return 'session-new';
    },
    async prompt(sessionId: string, _text: string, onEvent: (event: RunEvent) => void) {
      calls.push(['prompt', sessionId]);
      onEvent({ type: 'text', text: 'ok' });
      return { text: 'ok', reason: 'end_turn', timedOut: false, cancelled: false };
    },
    cancel() {
      calls.push(['cancel']);
    },
  };
  return { backend, calls };
}

function sourceOf(backend: unknown): KimiBackendSource {
  return { acquire: async () => backend as any, evict: () => undefined };
}

const baseInput = {
  id: 'task-1',
  task: 'do work',
  cwd: 'C:/proj',
  permissionMode: 'workspace-write',
  timeoutMs: 5_000,
  onEvent: () => undefined,
};

describe('KimiRunner', () => {
  it('有 resumeSessionId 时先 load 复用旧会话', async () => {
    const { backend, calls } = makeBackend();
    const runner = createKimiRunner({ pool: sourceOf(backend) });
    const outcome = await runner({ ...baseInput, resumeSessionId: 'session-old' }).outcome;
    expect(calls[0]).toEqual(['load', 'session-old']);
    expect(outcome.sessionId).toBe('session-old');
    expect(outcome.exitCode).toBe(0);
  });

  it('load 失败时回退新建并显式记录降级', async () => {
    const { backend, calls } = makeBackend({ loadFails: true });
    const events: RunEvent[] = [];
    const runner = createKimiRunner({ pool: sourceOf(backend) });
    const outcome = await runner({
      ...baseInput,
      resumeSessionId: 'session-gone',
      onEvent: (event) => events.push(event),
    }).outcome;
    expect(calls.some(([name]) => name === 'new')).toBe(true);
    expect(outcome.sessionId).toBe('session-new');
    expect(events.some((event) => event.type === 'status' && event.phase === 'session_resume_fallback')).toBe(true);
  });

  it('idle_after_tool 判成功并显式标注（不把做完的事判成失败）', async () => {
    const backend = {
      isClosed: false,
      isUnhealthy: false,
      diagnostics: '',
      async loadSession() {},
      async newSession() {
        return 'session-idle';
      },
      async prompt() {
        return { text: 'partial', reason: 'idle_after_tool', timedOut: false, cancelled: false };
      },
      cancel() {},
    };
    const events: RunEvent[] = [];
    const runner = createKimiRunner({ pool: sourceOf(backend) });
    const outcome = await runner({ ...baseInput, onEvent: (event) => events.push(event) }).outcome;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.errorMessage).toBeNull();
    expect(outcome.cancelled).toBe(false);
    expect(events.some((event) => event.type === 'status' && event.phase === 'idle_after_tool')).toBe(true);
  });

  it('取消只作用于本会话（带 sessionId）', async () => {
    const calls: Array<[string, string?]> = [];
    let releasePrompt: ((value: unknown) => void) | undefined;
    const backend = {
      isClosed: false,
      isUnhealthy: false,
      diagnostics: '',
      async loadSession() {
        calls.push(['load']);
      },
      async newSession() {
        calls.push(['new']);
        return 'session-x';
      },
      async prompt(sessionId: string) {
        calls.push(['prompt', sessionId]);
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      },
      cancel(sessionId?: string) {
        calls.push(['cancel', sessionId]);
      },
    };
    const runner = createKimiRunner({ pool: sourceOf(backend) });
    const handle = runner(baseInput);
    await waitFor(() => calls.some(([name]) => name === 'prompt'));
    handle.cancel();
    expect(calls).toContainEqual(['cancel', 'session-x']);
    releasePrompt?.({ text: null, reason: 'cancelled', timedOut: false, cancelled: true });
    const outcome = await handle.outcome;
    expect(outcome.cancelled).toBe(true);
  });
});

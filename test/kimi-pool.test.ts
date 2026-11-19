import { describe, expect, it } from 'vitest';
import { KimiBackendPool } from '../src/kimi-pool.js';

function fakeBackend(overrides: Record<string, unknown> = {}) {
  return {
    isClosed: false,
    isUnhealthy: false,
    activeSessions: 0,
    busy: false,
    lastUsed: Date.now(),
    close: async () => undefined,
    ...overrides,
  } as any;
}

const baseOptions = {
  command: 'kimi',
  args: ['acp'],
  initTimeoutMs: 1_000,
  idleMs: 60_000,
  sweepIntervalMs: 1_000_000,
};

describe('KimiBackendPool', () => {
  it('同一 cwd（大小写/尾斜杠不同）复用同一后端', async () => {
    let created = 0;
    const pool = new KimiBackendPool({
      ...baseOptions,
      createBackend: async () => {
        created += 1;
        return fakeBackend();
      },
    });
    const first = await pool.acquire('C:/proj');
    const second = await pool.acquire('c:/proj/');
    expect(second).toBe(first);
    expect(created).toBe(1);
    await pool.shutdown();
  });

  it('不健康的后端会被替换而不是复用', async () => {
    let created = 0;
    const pool = new KimiBackendPool({
      ...baseOptions,
      createBackend: async () => {
        created += 1;
        return fakeBackend({ isUnhealthy: created === 1 });
      },
    });
    const first = await pool.acquire('C:/proj');
    const second = await pool.acquire('C:/proj');
    expect(second).not.toBe(first);
    expect(created).toBe(2);
    await pool.shutdown();
  });

  it('shutdown 会关闭所有后端', async () => {
    let closed = 0;
    const pool = new KimiBackendPool({
      ...baseOptions,
      createBackend: async () => fakeBackend({ close: async () => { closed += 1; } }),
    });
    await pool.acquire('C:/a');
    await pool.acquire('C:/b');
    await pool.shutdown();
    expect(closed).toBe(2);
  });
});

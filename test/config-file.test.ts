import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadConfigFile, resolveConfigPath } from '../src/config-file.js';

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'awm-config-'));
  const file = join(dir, 'config.toml');
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('配置文件加载', () => {
  it('TOML 展平为 env 同构键', () => {
    const file = writeConfig(`
backend = "kimi"

[backends.kimi]
model = "kimi-code/k3"
effort = "low"
idle_after_tool_s = 90

[limits]
max_concurrent = 3
`);
    const loaded = loadConfigFile(file);
    expect(loaded.values.WORKER_BACKEND).toBe('kimi');
    expect(loaded.values.WORKER_KIMI_MODEL).toBe('kimi-code/k3');
    expect(loaded.values.WORKER_KIMI_EFFORT).toBe('low');
    expect(loaded.values.WORKER_KIMI_IDLE_AFTER_TOOL_S).toBe('90');
    expect(loaded.values.WORKER_MAX_CONCURRENT).toBe('3');
    expect(loaded.unknownKeys).toEqual([]);
  });

  it('布尔与数组按既有读取约定转换', () => {
    const file = writeConfig(`
[behavior]
evidence_git = false

[permissions]
allowed_cwds = ["D:/a", "D:/b"]

[backends.kimi]
args = ["acp", "--verbose"]
`);
    const loaded = loadConfigFile(file);
    expect(loaded.values.WORKER_EVIDENCE_GIT).toBe('0');
    expect(loaded.values.WORKER_ALLOWED_CWDS).toBe('D:/a;D:/b');
    expect(loaded.values.WORKER_KIMI_ARGS).toBe('acp --verbose');
  });

  it('未知键被收集，不会静默忽略', () => {
    const file = writeConfig(`
[backends.kimi]
modle = "typo"
`);
    const loaded = loadConfigFile(file);
    expect(loaded.unknownKeys).toContain('backends.kimi.modle');
  });

  it('非法 TOML 抛错', () => {
    const file = writeConfig('this is not toml = = =');
    expect(() => loadConfigFile(file)).toThrow(/TOML/);
  });

  it('WORKER_CONFIG 优先，默认路径不存在时不加载', () => {
    const file = writeConfig('backend = "kimi"');
    expect(resolveConfigPath({ WORKER_CONFIG: file })).toBe(file);
    expect(resolveConfigPath({ WORKER_HOME: '/tmp/nowhere-xyz' })).toBeUndefined();
  });
});

describe('loadConfig 合并优先级', () => {
  it('env 覆盖配置文件', () => {
    const file = writeConfig(`
[backends.kimi]
model = "kimi-code/k3"
`);
    const fromFile = loadConfig({ WORKER_CONFIG: file });
    expect(fromFile.kimi.model).toBe('kimi-code/k3');
    expect(fromFile.configFile).toBe(file);

    const overridden = loadConfig({ WORKER_CONFIG: file, WORKER_KIMI_MODEL: 'kimi-code/k3.1-pro' });
    expect(overridden.kimi.model).toBe('kimi-code/k3.1-pro');
  });

  it('未知配置项直接失败（避免配了不生效）', () => {
    const file = writeConfig(`
[backends.kimi]
modle = "typo"
`);
    expect(() => loadConfig({ WORKER_CONFIG: file })).toThrow(/未知配置项/);
  });
});

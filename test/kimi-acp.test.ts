import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseCommandExit } from '../src/evidence.js';
import { JsonRpcLineClient } from '../src/jsonrpc-line.js';
import { KimiAcpBackend, KimiEventNormalizer, kimiModeFor, kimiToolName } from '../src/kimi-acp-backend.js';
import type { RunEvent } from '../src/types.js';
import { waitFor } from './helpers.js';

function makeAgent() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const client = new JsonRpcLineClient(toClient, fromClient);
  const sent: Array<Record<string, any>> = [];
  fromClient.setEncoding('utf8');
  fromClient.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) sent.push(JSON.parse(line));
  });
  const emit = (message: Record<string, unknown>) => toClient.write(`${JSON.stringify(message)}\n`);
  return { client, sent, emit };
}

/** 模拟实测到的 Kimi 参数分片形态：content[].content.text 为增量文本。 */
function chunk(text: string) {
  return [{ type: 'content', content: { type: 'text', text } }];
}

describe('KimiEventNormalizer（以 kimi 2.4.1 实测行为为准）', () => {
  it('正文分片聚合为单条 text', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    for (const piece of ['当前', '目录', '存在', ' src']) {
      normalizer.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
    }
    normalizer.flush();
    expect(events).toEqual([{ type: 'text', text: '当前目录存在 src' }]);
  });

  it('tool_call 只报开始，不产出空的参数', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Bash', kind: 'execute' });
    expect(events).toEqual([{ type: 'status', phase: 'tool_start', tool: 'shell', title: 'Bash' }]);
  });

  it('in_progress 参数分片被拼装，终态成对产出 tool_call + tool_result', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Bash', kind: 'execute' });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress', content: chunk('{"command": ') });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress', content: chunk('"ls"}') });
    expect(events).toHaveLength(1);
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: chunk('a.txt\nb.txt\n') });
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: 'tool_call', tool: 'shell', call_id: 'tc-1', arguments: { command: 'ls' } });
    expect(events[2]).toMatchObject({ type: 'tool_result', call_id: 'tc-1', message: { isError: false } });
    expect((events[2] as any).message.content[0].text).toBe('a.txt\nb.txt\n');
  });

  it('usage_update 映射为上下文用量事件（不是计费口径）', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'usage_update', used: 15010, size: 1048576 });
    expect(events).toEqual([
      { type: 'status', phase: 'context_usage', context_tokens: 15010, max_context_tokens: 1048576 },
    ]);
  });

  it('rawInput 出现在 update 里时优先使用（实测形态）', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-r', title: 'Bash', kind: 'execute', content: chunk('') });
    normalizer.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-r',
      status: 'in_progress',
      title: 'Running: echo hi',
      rawInput: { command: 'echo hi' },
      content: chunk('{"command":"echo hi"}'),
    });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-r', status: 'completed', content: chunk('hi\n') });
    const call = events.find((event) => event.type === 'tool_call');
    expect(call).toMatchObject({ tool: 'shell', arguments: { command: 'echo hi' } });
  });

  it('参数彻底缺失时用 title 兜底，证据不为空', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-t', title: 'Bash', kind: 'execute' });
    normalizer.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-t',
      status: 'failed',
      title: 'Running: git branch --show-current',
      content: chunk('rejected'),
    });
    const call = events.find((event) => event.type === 'tool_call');
    expect(call).toMatchObject({ arguments: { command: 'git branch --show-current' } });
  });

  it('in_progress 是累积快照（实测形态）时也能解析参数', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-3', title: 'Bash', kind: 'execute' });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'in_progress', content: chunk('{"command": ') });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'in_progress', content: chunk('{"command": "ls"}') });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'completed', content: chunk('ok') });
    const call = events.find((event) => event.type === 'tool_call');
    expect(call).toMatchObject({ tool: 'shell', arguments: { command: 'ls' } });
  });

  it('failed 终态标记 isError', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    normalizer.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'Bash', kind: 'execute' });
    normalizer.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'failed', content: chunk('boom') });
    expect(events[2]).toMatchObject({ type: 'tool_result', call_id: 'tc-2', message: { isError: true } });
  });

  it('聚合后事件量远小于分片数（防 worker_status 撑爆）', () => {
    const events: RunEvent[] = [];
    const normalizer = new KimiEventNormalizer((event) => events.push(event));
    for (let i = 0; i < 200; i += 1) {
      normalizer.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(20) } });
    }
    normalizer.flush();
    expect(events.length).toBeLessThanOrEqual(4000 / 320 + 1);
    expect(events.every((event) => event.type === 'text')).toBe(true);
  });
});

describe('Kimi 证据解析', () => {
  it('失败命令的退出码能从 Kimi 输出解析出来', () => {
    const parsed = parseCommandExit(
      "ls: cannot access '/x': No such file or directory\nCommand failed with exit code: 2.",
      true,
    );
    expect(parsed.exitCode).toBe(2);
    expect(parsed.markers).toContain('[exit code: 2]');
  });

  it('无退出码时保持原行为（不猜）', () => {
    expect(parseCommandExit('ok', false).exitCode).toBe(0);
    expect(parseCommandExit('boom', true).exitCode).toBeNull();
  });
});

describe('Kimi 权限模式与工具名映射', () => {
  it('read-only 用 plan（不执行工具）', () => expect(kimiModeFor('read-only')).toBe('plan'));
  it('workspace-write 用 auto', () => expect(kimiModeFor('workspace-write')).toBe('auto'));
  it('danger-full-access 用 yolo', () => expect(kimiModeFor('danger-full-access')).toBe('yolo'));
  it('未知模式退化为 auto', () => expect(kimiModeFor('whatever')).toBe('auto'));
  it('工具名归一到既有证据集合', () => {
    expect(kimiToolName('execute')).toBe('shell');
    expect(kimiToolName('edit')).toBe('edit');
    expect(kimiToolName('read')).toBe('read');
    expect(kimiToolName(undefined)).toBe('unknown');
  });
});

describe('KimiAcpBackend 多会话与恢复', () => {
  it('同一进程可并发承载两个会话', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write' });
    const first = backend.prompt('s1', 'a', () => undefined, 5_000);
    const second = backend.prompt('s2', 'b', () => undefined, 5_000);
    await waitFor(() => sent.filter((message) => message.method === 'session/prompt').length === 2);
    const requests = sent.filter((message) => message.method === 'session/prompt');
    emit({ jsonrpc: '2.0', id: requests[0]?.id, result: { stopReason: 'end_turn' } });
    emit({ jsonrpc: '2.0', id: requests[1]?.id, result: { stopReason: 'end_turn' } });
    await expect(first).resolves.toMatchObject({ reason: 'end_turn' });
    await expect(second).resolves.toMatchObject({ reason: 'end_turn' });
  });

  it('loadSession 发 session/load 并等待回放静默', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write' });
    const loading = backend.loadSession('session-old', 'C:/p', 'workspace-write');
    await waitFor(() => sent.some((message) => message.method === 'session/load'));
    const request = sent.find((message) => message.method === 'session/load');
    expect(request?.params).toMatchObject({ sessionId: 'session-old', cwd: 'C:/p' });
    emit({ jsonrpc: '2.0', id: request?.id, result: {} });
    // 回放事件不应污染后续正文（此期间没有 pending）
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-old', update: { sessionUpdate: 'usage_update', used: 100, size: 1_000 } },
    });
    // 回放静默后才会切 mode：补上响应，否则 loadSession 会等到超时
    await waitFor(() => sent.some((message) => message.method === 'session/set_mode'), 5_000);
    const modeRequest = sent.find((message) => message.method === 'session/set_mode');
    emit({ jsonrpc: '2.0', id: modeRequest?.id, result: {} });
    await loading;
  });
});

describe('Kimi 会话级模型配置', () => {
  async function bootSession(backend: KimiAcpBackend, sent: Array<Record<string, any>>, emit: (m: unknown) => void) {
    const creating = backend.newSession('C:/p');
    await waitFor(() => sent.some((m) => m.method === 'session/new'));
    const newReq = sent.find((m) => m.method === 'session/new');
    emit({
      jsonrpc: '2.0',
      id: newReq?.id,
      result: {
        sessionId: 's1',
        configOptions: [{ id: 'model', options: [{ value: 'kimi-code/k3' }, { value: 'kimi-code/k3.1-pro' }] }],
      },
    });
    await waitFor(() => sent.some((m) => m.method === 'session/set_mode'));
    const modeReq = sent.find((m) => m.method === 'session/set_mode');
    emit({ jsonrpc: '2.0', id: modeReq?.id, result: {} });
    await waitFor(() => sent.some((m) => m.method === 'session/set_config_option'));
    return { creating, cfgReq: sent.find((m) => m.method === 'session/set_config_option') };
  }

  it('配置了 model 时在建会话后切模型，并记录可用列表', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write', model: 'kimi-code/k3' });
    const { creating, cfgReq } = await bootSession(backend, sent, emit);
    expect(cfgReq?.params).toMatchObject({ sessionId: 's1', configId: 'model', value: 'kimi-code/k3' });
    emit({ jsonrpc: '2.0', id: cfgReq?.id, result: { configOptions: [{ id: 'model', options: [{ value: 'kimi-code/k3' }] }] } });
    await expect(creating).resolves.toBe('s1');
    expect(backend.availableModels).toContain('kimi-code/k3');
  });

  it('模型不可用时直接失败，并把可用模型列出来', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write', model: 'nope-model' });
    const { creating, cfgReq } = await bootSession(backend, sent, emit);
    emit({ jsonrpc: '2.0', id: cfgReq?.id, error: { code: -32603, message: 'unknown model' } });
    await expect(creating).rejects.toThrow(/kimi-code\/k3/);
  });

  it('未配置 model 时不会发 set_config_option', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write' });
    const creating = backend.newSession('C:/p');
    await waitFor(() => sent.some((m) => m.method === 'session/new'));
    const newReq = sent.find((m) => m.method === 'session/new');
    emit({ jsonrpc: '2.0', id: newReq?.id, result: { sessionId: 's1', configOptions: [] } });
    await waitFor(() => sent.some((m) => m.method === 'session/set_mode'));
    const modeReq = sent.find((m) => m.method === 'session/set_mode');
    emit({ jsonrpc: '2.0', id: modeReq?.id, result: {} });
    await expect(creating).resolves.toBe('s1');
    expect(sent.some((m) => m.method === 'session/set_config_option')).toBe(false);
  });
});

describe('KimiAcpBackend 空转看守', () => {
  it('工具完成后再无事件时，以 idle_after_tool 收尾并发出 session/cancel', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write', idleAfterToolMs: 120 });
    const events: RunEvent[] = [];
    const pending = backend.prompt('s1', 'x', (event) => events.push(event), 30_000);
    await waitFor(() => sent.some((message) => message.method === 'session/prompt'));
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', title: 'Bash' } } });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: chunk('feat/x') } } });

    const outcome = await pending;
    expect(outcome.reason).toBe('idle_after_tool');
    expect(outcome.cancelled).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(sent.some((message) => message.method === 'session/cancel')).toBe(true);
    expect(events.some((event) => event.type === 'status' && event.reason === 'idle_after_tool')).toBe(true);
  });

  it('没有工具结果时看守不触发（纯文本生成不误杀）', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write', idleAfterToolMs: 100 });
    const pending = backend.prompt('s2', 'x', () => undefined, 2_000);
    await waitFor(() => sent.some((message) => message.method === 'session/prompt'));
    const request = sent.find((message) => message.method === 'session/prompt');
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
    emit({ jsonrpc: '2.0', id: request?.id, result: { stopReason: 'end_turn' } });
    const outcome = await pending;
    expect(outcome.reason).toBe('end_turn');
  });
});

describe('KimiAcpBackend 会话', () => {
  it('prompt 全流程：正文聚合 + stopReason 结束', async () => {
    const { client, sent, emit } = makeAgent();
    const backend = new KimiAcpBackend({ client, permissionMode: 'workspace-write' });
    const events: RunEvent[] = [];
    const pending = backend.prompt('s1', '你好', (event) => events.push(event), 5_000);
    await waitFor(() => sent.some((message) => message.method === 'session/prompt'));
    const request = sent.find((message) => message.method === 'session/prompt');
    expect(request?.params).toMatchObject({ sessionId: 's1', prompt: [{ type: 'text', text: '你好' }] });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '可' } } } });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '以' } } } });
    emit({ jsonrpc: '2.0', id: request?.id, result: { stopReason: 'end_turn' } });
    const outcome = await pending;
    expect(outcome).toMatchObject({ reason: 'end_turn', text: '可以', cancelled: false, timedOut: false });
    expect(events.filter((event) => event.type === 'text')).toHaveLength(1);
  });

  it('workspace-write 对权限请求选 allow', async () => {
    const { client, sent, emit } = makeAgent();
    new KimiAcpBackend({ client, permissionMode: 'workspace-write' });
    emit({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'tc-1' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } });
    await waitFor(() => sent.some((message) => message.id === 'perm-1'));
    expect(sent.find((message) => message.id === 'perm-1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('read-only 对权限请求选 reject', async () => {
    const { client, sent, emit } = makeAgent();
    new KimiAcpBackend({ client, permissionMode: 'read-only' });
    emit({ jsonrpc: '2.0', id: 'perm-2', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'tc-1' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } });
    await waitFor(() => sent.some((message) => message.id === 'perm-2'));
    expect(sent.find((message) => message.id === 'perm-2')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
  });
});

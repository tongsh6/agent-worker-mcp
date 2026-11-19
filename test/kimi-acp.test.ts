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

  it('聚合后事件量远小于分片数（防 dsh_status 撑爆）', () => {
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

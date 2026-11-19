import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcLineClient } from '../src/jsonrpc-line.js';
import { waitFor } from './helpers.js';

function makePair() {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const client = new JsonRpcLineClient(clientInput, clientOutput);
  const sent: Array<Record<string, unknown>> = [];
  clientOutput.setEncoding('utf8');
  clientOutput.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const reply = (message: Record<string, unknown>) => clientInput.write(`${JSON.stringify(message)}\n`);
  return { client, sent, reply };
}

describe('JsonRpcLineClient 服务端请求（ACP 需要）', () => {
  it('服务端主动请求由处理器应答，id 原样回传', async () => {
    const { client, sent, reply } = makePair();
    client.onRequest('session/request_permission', (params) => {
      expect(params).toMatchObject({ sessionId: 's1' });
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    });
    reply({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 's1' } });
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 'perm-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
  });

  it('未注册处理器时回 -32601', async () => {
    const { client, sent, reply } = makePair();
    reply({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: 'a' } });
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it('处理器抛错时回 error 而不是挂起', async () => {
    const { client, sent, reply } = makePair();
    client.onRequest('fs/write_text_file', () => {
      throw new Error('拒绝写入');
    });
    reply({ jsonrpc: '2.0', id: 8, method: 'fs/write_text_file', params: {} });
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ id: 8, error: { code: -32603, message: expect.stringContaining('拒绝写入') } });
  });
});

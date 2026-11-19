/**
 * 最小 JSON-RPC 2.0 行分帧客户端。
 * - 请求/响应关联、通知分发、超时、关闭（DSH SDK 协议用）；
 * - 服务端主动请求（ACP 的 session/request_permission、fs/* 会用到）由 onRequest 注册的处理器应答。
 */
export interface JsonRpcResponseError {
  code: number;
  message: string;
  data?: unknown;
}

/** 服务端主动请求的处理器：返回值即应答 result；抛错则回 -32603。 */
export type JsonRpcRequestHandler = (params: unknown) => unknown | Promise<unknown>;

export class JsonRpcLineClient {
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string) => this.onData(chunk));
    input.on('close', () => this.close(new Error('JSON-RPC 通道已关闭')));
    input.on('error', (error: Error) => this.close(error));
  }

  request<T>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC 通道已关闭'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC 请求超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 发送通知（无 id，不等应答）；ACP 的 session/cancel 走这里。 */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** 订阅服务端通知；返回取消订阅函数。 */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>();
    set.add(handler);
    this.notificationHandlers.set(method, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.notificationHandlers.delete(method);
    };
  }

  /** 应答服务端主动请求；未注册的方法由客户端统一回 -32601，避免对端挂起。 */
  onRequest(method: string, handler: JsonRpcRequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  close(error: Error = new Error('JSON-RPC 客户端已关闭')): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 格式错误行按规范忽略
    }
    const id = message.id;
    const method = message.method;
    const isResponse = typeof id === 'number' && typeof method !== 'string';
    if (isResponse) {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      const error = message.error as JsonRpcResponseError | undefined;
      if (error) {
        entry.reject(Object.assign(new Error(`JSON-RPC 错误：${error.message}`), { code: error.code, data: error.data }));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof method === 'string') {
      // 服务端主动请求：有 method 且有 id，必须应答，否则对端会一直等待
      if (id !== undefined && id !== null) {
        void this.handleServerRequest(method, id, message.params);
        return;
      }
      const handlers = this.notificationHandlers.get(method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch {
            // 单个订阅者异常不影响其它订阅者
          }
        }
      }
    }
  }

  private async handleServerRequest(method: string, id: unknown, params: unknown): Promise<void> {
    if (this.closed) return;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      if (!this.closed) this.write({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (error) {
      if (!this.closed) {
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

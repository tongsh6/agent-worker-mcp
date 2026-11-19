import { spawn, type ChildProcess } from 'node:child_process';
import { WorkerError } from './errors.js';
import { JsonRpcLineClient } from './jsonrpc-line.js';
import type { PromptOutcome } from './sdk-backend.js';
import type { RunEvent } from './types.js';

const STDERR_TAIL_CHARS = 8 * 1024;
/** 取消后等待 agent 自行收尾的宽限；超时后只判定该会话失败，不杀进程（同一 cwd 可能还有别的会话）。 */
const CANCEL_GRACE_MS = 8_000;
/** 正文聚合：Kimi 按 token 逐片推送，逐片发事件会把 worker_status 撑爆。 */
const TEXT_FLUSH_CHARS = 320;
const TEXT_FLUSH_MS = 700;
/** session/load 会回放历史；等这段静默期结束，再发 prompt，避免历史正文混进本轮。 */
const REPLAY_QUIET_MS = 800;
const REPLAY_MAX_MS = 6_000;
/** 工具完成后多久没有任何事件就主动收尾（默认 120s；可用 WORKER_KIMI_IDLE_AFTER_TOOL_S 覆盖，0 关闭）。 */
const DEFAULT_IDLE_AFTER_TOOL_MS = 120_000;

/** Kimi Code CLI 的会话 mode（实测 session/new 返回的 availableModes）。 */
export type KimiMode = 'plan' | 'auto' | 'yolo' | 'default';

/**
 * 权限模式映射（按「能做什么」对齐，而不是按名字）：
 * - read-only：plan —— 只读规划，不执行工具，最接近只读语义；
 * - workspace-write：auto —— 自动批准安全操作，危险动作仍走 request_permission；
 * - danger-full-access：yolo —— 全部自动批准。
 * 注意：这不是文件系统级强制隔离（Kimi 没有 OS 沙箱），只是审批强度。
 */
export function kimiModeFor(permissionMode: string): KimiMode {
  if (permissionMode === 'read-only') return 'plan';
  if (permissionMode === 'danger-full-access') return 'yolo';
  return 'auto';
}

/** 把 ACP 的 tool kind 归一到本项目证据解析认识的工具名。 */
export function kimiToolName(kind: unknown): string {
  switch (kind) {
    case 'execute':
      return 'shell';
    case 'edit':
      return 'edit';
    case 'read':
      return 'read';
    case 'search':
      return 'grep';
    case 'move':
      return 'move';
    case 'delete':
      return 'delete';
    case 'fetch':
      return 'fetch';
    default:
      return typeof kind === 'string' && kind.length > 0 ? kind : 'unknown';
  }
}

function renderChunk(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof content === 'string') return content;
  // 正文分片实测是对象形态：{ type: 'text', text }；工具参数/输出是数组形态
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    const inner = record.content as Record<string, unknown> | undefined;
    if (inner && typeof inner.text === 'string') return inner.text;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = item as Record<string, unknown>;
        const inner = record.content as Record<string, unknown> | undefined;
        if (inner && typeof inner.text === 'string') return inner.text;
        if (typeof record.text === 'string') return record.text;
        return '';
      })
      .join('');
  }
  return '';
}

function renderRawOutput(update: Record<string, unknown>): string {
  const raw = update.rawOutput;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of ['output', 'text', 'content', 'error', 'stderr', 'stdout']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    try {
      return JSON.stringify(raw).slice(0, 4_000);
    } catch {
      return '';
    }
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseArguments(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface ToolState {
  tool: string;
  title?: string;
  /** in_progress 阶段的累积快照（实测是逐步变长的前缀，不是增量）。 */
  argsText: string;
  /** 结构化参数：实测常出现在某条 `in_progress` 上，比 content 快照更可靠，优先使用。 */
  rawInput?: Record<string, unknown>;
}

/**
 * ACP session/update → 本项目 RunEvent 的规范化层。
 *
 * 实测（kimi 2.4.1）给出的硬约束：
 * 1. `tool_call` 事件里 rawInput 为空，参数是 `tool_call_update` 的累积快照；
 * 2. `in_progress` 只是过程片段，不能当结果；
 * 3. 正文按 token 逐片到达，必须聚合；
 * 4. `usage_update` 是上下文占用（used/size），不是计费口径的 input/output。
 */
export class KimiEventNormalizer {
  private textBuffer = '';
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly tools = new Map<string, ToolState>();
  private closed = false;

  constructor(private readonly emit: (event: RunEvent) => void) {}

  push(update: Record<string, unknown>): void {
    if (this.closed) return;
    const type = update.sessionUpdate;
    if (type === 'agent_message_chunk') {
      const chunk = renderChunk(update);
      if (chunk.length > 0) this.appendText(chunk);
      return;
    }
    if (type === 'tool_call') {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!callId) return;
      const title = typeof update.title === 'string' ? update.title : undefined;
      const tool = kimiToolName(update.kind);
      // 参数可能在初始事件里（content / rawInput），也可能完全不出现——先收下能收到的
      const initialRaw = asRecord(update.rawInput);
      const initialChunk = renderChunk(update);
      this.tools.set(callId, {
        tool,
        ...(title ? { title } : {}),
        argsText: initialChunk,
        ...(Object.keys(initialRaw).length > 0 ? { rawInput: initialRaw } : {}),
      });
      // 只报「开始」，参数与结果在终态一起给出（保证 evidence 拿到完整命令）
      this.emit({ type: 'status', phase: 'tool_start', tool, ...(title ? { title } : {}) });
      return;
    }
    if (type === 'tool_call_update') {
      this.onToolUpdate(update);
      return;
    }
    if (type === 'usage_update') {
      const used = typeof update.used === 'number' ? update.used : undefined;
      const size = typeof update.size === 'number' ? update.size : undefined;
      if (used !== undefined) {
        this.emit({
          type: 'status',
          phase: 'context_usage',
          context_tokens: used,
          ...(size !== undefined ? { max_context_tokens: size } : {}),
        });
      }
      return;
    }
    if (type === 'current_mode_update') {
      this.emit({ type: 'status', phase: 'mode', mode: update.currentModeId });
      return;
    }
    if (type === 'plan') {
      this.emit({ type: 'status', phase: 'plan', entries: update.entries });
    }
    // user_message_chunk / session_info_update / config_option_update 等不进入任务正文
  }

  /** 结算前把剩余正文吐出，避免最后一段丢失。 */
  flush(): void {
    this.flushText();
  }

  close(): void {
    this.closed = true;
    this.flushText();
  }

  private onToolUpdate(update: Record<string, unknown>): void {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!callId) return;
    const status = typeof update.status === 'string' ? update.status : 'in_progress';
    const existing = this.tools.get(callId) ?? {
      tool: kimiToolName(update.kind),
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      argsText: '',
    };
    this.tools.set(callId, existing);

    // 后续 update 常带更具体的 title（如 "Running: git branch --show-current"），兜底时用它
    if (typeof update.title === 'string' && update.title.length > 0) existing.title = update.title;

    // 结构化参数可能出现在任意一条 update 上（实测 in_progress 阶段最常见），优先采集
    const incomingRaw = asRecord(update.rawInput);
    if (Object.keys(incomingRaw).length > 0) existing.rawInput = incomingRaw;

    if (status === 'in_progress' || status === 'pending') {
      const snapshot = renderChunk(update);
      if (snapshot.length > 0) {
        existing.argsText = snapshot.startsWith(existing.argsText) ? snapshot : existing.argsText + snapshot;
      }
      return;
    }

    const output = renderChunk(update) || renderRawOutput(update);
    const isError = status === 'failed';
    this.emit({
      type: 'tool_call',
      tool: existing.tool,
      call_id: callId,
      ...(existing.title ? { title: existing.title } : {}),
      arguments: this.resolveArguments(existing),
    });
    this.emit({
      type: 'tool_result',
      call_id: callId,
      status,
      message: { isError, content: output.length > 0 ? [{ type: 'text', text: output }] : [] },
    });
    this.tools.delete(callId);
  }

  /**
   * 参数解析优先级：rawInput（结构化）> content 累积快照 > title 兜底。
   * 最后一层是为了「参数彻底缺失时，证据里至少还有命令文本」，避免 evidence 静默为空。
   */
  private resolveArguments(state: ToolState): Record<string, unknown> {
    if (state.rawInput && Object.keys(state.rawInput).length > 0) return state.rawInput;
    const parsed = parseArguments(state.argsText);
    if (Object.keys(parsed).length > 0) return parsed;
    const running = state.title?.match(/^Running:\s*(.+)$/);
    if (running && state.tool === 'shell') return { command: running[1] };
    return {};
  }

  private appendText(chunk: string): void {
    this.textBuffer += chunk;
    if (this.textBuffer.length >= TEXT_FLUSH_CHARS) {
      this.flushText();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushText(), TEXT_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.textBuffer.length === 0) return;
    const text = this.textBuffer;
    this.textBuffer = '';
    this.emit({ type: 'text', text });
  }
}

/** 进程级兜底：worker 异常退出时不让 kimi 子进程变孤儿。 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    const killAll = (): void => {
      for (const tracked of liveChildren) {
        try {
          tracked.kill();
        } catch {
          // 兜底清理失败不影响退出
        }
      }
      liveChildren.clear();
    };
    process.on('exit', killAll);
    process.on('SIGINT', killAll);
    process.on('SIGTERM', killAll);
  }
}

export interface KimiSpawnOptions {
  /** 通常是 `kimi`。 */
  command: string;
  /** 默认 ['acp']。 */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  permissionMode?: string;
  initTimeoutMs?: number;
  /** 工具完成后的空转看守（毫秒）；0 = 关闭。 */
  idleAfterToolMs?: number;
  /** 会话级模型（ACP config option `model`）；缺省用 Kimi CLI 默认。 */
  model?: string;
  /** 会话级思考档位（ACP config option `thinking`：low / high / max）；缺省用模型默认。 */
  effort?: string;
}

export interface KimiAcpBackendInit {
  client: JsonRpcLineClient;
  permissionMode: string;
  pid?: number | null;
  onKill?: () => void;
  diagnostics?: () => string;
  /** 工具完成后的空转看守（毫秒）；0 = 关闭。 */
  idleAfterToolMs?: number;
  /** 会话级模型（ACP config option `model`）；缺省用 Kimi CLI 默认。 */
  model?: string;
  /** 会话级思考档位（ACP config option `thinking`）；缺省用模型默认。 */
  effort?: string;
}

interface PendingPrompt {
  sessionId: string;
  onEvent: (event: RunEvent) => void;
  /** 聚合后的正文（normalizer 合并分片后写入）。 */
  assistantText: string;
  normalizer: KimiEventNormalizer;
  timedOut: boolean;
  cancelled: boolean;
  timer: NodeJS.Timeout | undefined;
  /** 最后一次收到会话事件的时间：空转看守据此判断「工具做完后是否还有进展」。 */
  lastEventAt: number;
  /** 本轮是否已有工具执行完成（看守只在有工具结果后生效，避免误杀纯文本生成）。 */
  hasToolResult: boolean;
  /** 空转看守计时器。 */
  idleTimer: NodeJS.Timeout | undefined;
  /** 已由空转看守收尾（区别于用户取消）。 */
  idleSettled: boolean;
  resolve: (outcome: PromptOutcome) => void;
}

/**
 * 长驻 `kimi acp` 后端：一个进程承载多个会话（池化的前提）。
 * ACP 原生支持 session/cancel、session/request_permission 与 session/load。
 */
export class KimiAcpBackend {
  readonly pid: number | null;
  private closed = false;
  private unhealthy = false;
  private closedReason: string | null = null;
  private lastUsedAt = Date.now();
  private agentInfo: { name?: string; version?: string } | null = null;
  private readonly pending = new Map<string, PendingPrompt>();
  /** 会话级权限策略：池化后同一进程可能承载不同权限模式的任务。 */
  private readonly sessionModes = new Map<string, string>();
  private readonly idleAfterToolMs: number;
  private readonly modelOverride?: string;
  private readonly effortOverride?: string;
  /** 最近一次会话的 configOptions（model / thinking 等），用于配置出错时给出候选。 */
  private lastConfigOptions: Array<{ id?: string; options?: Array<{ value?: string }> }> = [];
  private replayDone: (() => void) | undefined;

  constructor(private readonly init: KimiAcpBackendInit) {
    this.pid = init.pid ?? null;
    this.idleAfterToolMs = init.idleAfterToolMs ?? DEFAULT_IDLE_AFTER_TOOL_MS;
    this.modelOverride = init.model?.trim() ? init.model.trim() : undefined;
    this.effortOverride = init.effort?.trim() ? init.effort.trim() : undefined;
    init.client.onNotification('session/update', (params) => this.onUpdate(params));
    init.client.onRequest('session/request_permission', (params) => this.onPermission(params));
  }

  /** 拉起 `kimi acp` 并完成 initialize 握手。 */
  static async start(options: KimiSpawnOptions): Promise<KimiAcpBackend> {
    const child = spawn(options.command, options.args ?? ['acp'], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackChild(child);
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    const client = new JsonRpcLineClient(child.stdout, child.stdin);
    const backend = new KimiAcpBackend({
      client,
      permissionMode: options.permissionMode ?? 'workspace-write',
      pid: child.pid ?? null,
      onKill: () => child.kill(),
      diagnostics: () => stderrTail,
      ...(options.idleAfterToolMs !== undefined ? { idleAfterToolMs: options.idleAfterToolMs } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    });
    child.on('error', (error: Error) => backend.markClosed(error.message));
    child.on('exit', (code, signal) => {
      liveChildren.delete(child);
      backend.markClosed(`Kimi ACP 进程退出（code=${String(code)}, signal=${String(signal)}）`);
    });

    const result = await client.request<{ agentInfo?: { name?: string; version?: string }; protocolVersion?: number }>(
      'initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      options.initTimeoutMs ?? 60_000,
    );
    const agentInfo = result?.agentInfo ?? {};
    if (!agentInfo.name || !agentInfo.name.toLowerCase().includes('kimi')) {
      child.kill();
      throw new WorkerError('internal', `Kimi ACP 握手返回了非预期身份：${JSON.stringify(result)}`);
    }
    backend.agentInfo = agentInfo;
    return backend;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 会话因此前的取消/超时未正常收尾：下次分配时应换新进程。 */
  get isUnhealthy(): boolean {
    return this.unhealthy;
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get activeSessions(): number {
    return this.pending.size;
  }

  get lastUsed(): number {
    return this.lastUsedAt;
  }

  get info(): { name?: string; version?: string } | null {
    return this.agentInfo;
  }

  /** 最近一次会话可用的模型列表（来自 ACP configOptions）；未建过会话时为空。 */
  get availableModels(): string[] {
    return this.availableValues('model');
  }

  /** 最近一次会话可用的思考档位（ACP `thinking`）；未建过会话时为空。 */
  get availableEfforts(): string[] {
    return this.availableValues('thinking');
  }

  get diagnostics(): string {
    return this.init.diagnostics?.() ?? '';
  }

  markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    for (const sessionId of [...this.pending.keys()]) this.settlePending(sessionId, { error: reason });
  }

  /** 新建会话：按权限模式切 mode（plan/auto/yolo），并按配置切模型。 */
  async newSession(cwd: string, permissionMode?: string): Promise<string> {
    this.assertOpen();
    const result = await this.init.client.request<{
      sessionId?: string;
      configOptions?: Array<{ id?: string; options?: Array<{ value?: string }> }>;
    }>('session/new', { cwd, mcpServers: [] }, 60_000);
    if (!result?.sessionId) {
      throw new WorkerError('internal', `Kimi ACP session/new 未返回 sessionId：${JSON.stringify(result)}`);
    }
    this.captureConfigOptions(result.configOptions);
    this.sessionModes.set(result.sessionId, permissionMode ?? this.init.permissionMode);
    await this.applyMode(result.sessionId, permissionMode);
    await this.applyConfigOptions(result.sessionId);
    this.lastUsedAt = Date.now();
    return result.sessionId;
  }

  /**
   * 恢复已有会话（ACP session/load）。load 会异步回放历史事件；
   * 这里等回放静默后再返回，期间没有 pending，回放事件天然被丢弃，不污染本轮正文。
   */
  async loadSession(sessionId: string, cwd: string, permissionMode?: string): Promise<void> {
    this.assertOpen();
    await this.init.client.request('session/load', { sessionId, cwd, mcpServers: [] }, 60_000);
    await this.watchReplay();
    this.sessionModes.set(sessionId, permissionMode ?? this.init.permissionMode);
    await this.applyMode(sessionId, permissionMode);
    await this.applyConfigOptions(sessionId);
    this.lastUsedAt = Date.now();
  }

  async prompt(
    sessionId: string,
    text: string,
    onEvent: (event: RunEvent) => void,
    timeoutMs: number,
  ): Promise<PromptOutcome> {
    this.assertOpen();
    if (this.pending.has(sessionId)) {
      throw new WorkerError('internal', `Kimi session 已有进行中的任务：${sessionId}`);
    }
    this.lastUsedAt = Date.now();

    return new Promise<PromptOutcome>((resolve) => {
      const state: PendingPrompt = {
        sessionId,
        onEvent,
        assistantText: '',
        normalizer: undefined as unknown as KimiEventNormalizer,
        timedOut: false,
        cancelled: false,
        timer: undefined,
        lastEventAt: Date.now(),
        hasToolResult: false,
        idleTimer: undefined,
        idleSettled: false,
        resolve,
      };
      state.normalizer = new KimiEventNormalizer((event) => {
        if (event.type === 'text' && typeof event.text === 'string') state.assistantText += event.text;
        if (event.type === 'tool_result') state.hasToolResult = true;
        onEvent(event);
      });
      state.timer = setTimeout(() => {
        state.timedOut = true;
        this.cancel(sessionId);
      }, Math.max(1_000, timeoutMs));
      this.pending.set(sessionId, state);
      if (this.idleAfterToolMs > 0) {
        const interval = Math.max(50, Math.min(15_000, Math.floor(this.idleAfterToolMs / 2)));
        state.idleTimer = setInterval(() => this.checkIdle(sessionId), interval);
        state.idleTimer.unref?.();
      }

      onEvent({ type: 'status', phase: 'turn_start', turn: 1 });
      this.init.client
        .request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs + 60_000)
        .then((result) => {
          const stopReason = (result as { stopReason?: string } | undefined)?.stopReason ?? 'end_turn';
          this.settlePending(sessionId, { reason: stopReason });
        })
        .catch((error: unknown) => {
          this.settlePending(sessionId, { error: error instanceof Error ? error.message : String(error) });
        });
    });
  }

  /**
   * ACP 原生取消。宽限期内没结束：只把该会话判定为失败并标记后端不健康，
   * 不杀进程（同一 cwd 可能还有别的会话在跑）。
   */
  cancel(sessionId?: string): void {
    const targets = sessionId ? [sessionId] : [...this.pending.keys()];
    for (const target of targets) {
      const state = this.pending.get(target);
      if (!state) continue;
      state.cancelled = true;
      this.init.client.notify('session/cancel', { sessionId: target });
      const timer = setTimeout(() => {
        if (!this.pending.has(target)) return;
        this.unhealthy = true;
        this.settlePending(target, { reason: 'cancelled' });
      }, CANCEL_GRACE_MS);
      timer.unref?.();
    }
  }

  /**
   * 空转看守：工具已经执行完成、但会话迟迟不返回（例如上游模型服务 500 后长时间重试）时，
   * 主动取消并按「已完成的工作」收尾。否则整轮只能等到总超时，把做成的事判成取消。
   */
  private checkIdle(sessionId: string): void {
    const state = this.pending.get(sessionId);
    if (!state || state.idleSettled) return;
    if (!state.hasToolResult) return;
    if (Date.now() - state.lastEventAt < this.idleAfterToolMs) return;
    state.idleSettled = true;
    this.init.client.notify('session/cancel', { sessionId });
    this.settlePending(sessionId, { reason: 'idle_after_tool' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.markClosed('后端被主动关闭');
    this.init.onKill?.();
  }

  private assertOpen(): void {
    if (this.closed) throw new WorkerError('internal', `Kimi ACP 后端已关闭：${this.closedReason ?? 'unknown'}`);
  }

  private async applyMode(sessionId: string, permissionMode?: string): Promise<void> {
    const mode = kimiModeFor(permissionMode ?? this.init.permissionMode);
    // 10s 足够；太长会让「恢复会话」在 set_mode 无响应时被拖住
    await this.init.client.request('session/set_mode', { sessionId, modeId: mode }, 10_000).catch(() => {
      // 老版本可能没有 set_mode；切不过去不影响任务本身
    });
  }

  /**
   * 会话级可调项：模型（model）与思考档位（thinking）。
   * 切不过去是**配置错误**，直接失败并列出该项的可用值——静默回落会让人以为生效了。
   */
  private async applyConfigOptions(sessionId: string): Promise<void> {
    await this.applyConfigValue(sessionId, 'model', this.modelOverride, 'WORKER_KIMI_MODEL');
    await this.applyConfigValue(sessionId, 'thinking', this.effortOverride, 'WORKER_KIMI_EFFORT');
  }

  private async applyConfigValue(
    sessionId: string,
    configId: string,
    value: string | undefined,
    envName: string,
  ): Promise<void> {
    if (!value) return;
    try {
      const result = await this.init.client.request<{
        configOptions?: Array<{ id?: string; options?: Array<{ value?: string }> }>;
      }>('session/set_config_option', { sessionId, configId, value }, 15_000);
      this.captureConfigOptions(result?.configOptions);
    } catch (error) {
      const available = this.availableValues(configId);
      const label = configId === 'model' ? '模型' : '思考档位';
      throw new WorkerError(
        'bad_request',
        `Kimi ${label}「${value}」不可用（${envName}）。可用：${available.length > 0 ? available.join(', ') : '(未能取得候选列表)'}。原始错误：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private captureConfigOptions(configOptions?: Array<{ id?: string; options?: Array<{ value?: string }> }>): void {
    if (!configOptions || configOptions.length === 0) return;
    this.lastConfigOptions = configOptions;
  }

  private availableValues(configId: string): string[] {
    const option = this.lastConfigOptions.find((item) => item.id === configId);
    return (option?.options ?? [])
      .map((item) => item.value)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  /** session/load 后的回放一般几十毫秒到一两秒；用「静默」判据，最多等 REPLAY_MAX_MS。 */
  private watchReplay(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let quietTimer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        this.replayDone = undefined;
        resolve();
      };
      const bump = (): void => {
        if (settled) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, REPLAY_QUIET_MS);
        quietTimer.unref?.();
      };
      const maxTimer = setTimeout(done, REPLAY_MAX_MS);
      maxTimer.unref?.();
      this.replayDone = bump;
      bump();
    });
  }

  private onUpdate(params: unknown): void {
    const payload = params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
    const update = payload?.update;
    if (!update) return;
    this.replayDone?.();
    const state = payload?.sessionId ? this.pending.get(payload.sessionId) : undefined;
    if (!state) return;
    this.lastUsedAt = Date.now();
    state.lastEventAt = Date.now();
    state.normalizer.push(update);
  }

  /**
   * 权限请求应答：read-only 一律拒绝，其余按 allow 优先。
   * 这里只决定「批或不批」，真正的隔离强度来自 mode（plan/auto/yolo）。
   */
  private onPermission(params: unknown): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
    const payload = params as { sessionId?: string; options?: Array<{ optionId?: string; kind?: string }> } | undefined;
    const options = Array.isArray(payload?.options) ? payload.options : [];
    const mode = (payload?.sessionId ? this.sessionModes.get(payload.sessionId) : undefined) ?? this.init.permissionMode;
    const preferredKinds =
      mode === 'read-only'
        ? ['reject_once', 'reject_always']
        : ['allow_once', 'allow_always'];
    for (const kind of preferredKinds) {
      const found = options.find((option) => option.kind === kind && typeof option.optionId === 'string');
      if (found) return { outcome: { outcome: 'selected', optionId: found.optionId as string } };
    }
    const fallback = options.find((option) => typeof option.optionId === 'string');
    if (fallback) return { outcome: { outcome: 'selected', optionId: fallback.optionId as string } };
    return { outcome: { outcome: 'cancelled' } };
  }

  private settlePending(sessionId: string, extra: { reason?: string; error?: string }): void {
    const state = this.pending.get(sessionId);
    if (!state) return;
    this.pending.delete(sessionId);
    clearTimeout(state.timer);
    if (state.idleTimer) clearInterval(state.idleTimer);
    state.normalizer.close();
    const collected = state.assistantText;
    const reason = extra.reason ?? null;
    state.onEvent({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      ...(reason ? { reason } : {}),
      ...(state.timedOut ? { timed_out: true } : {}),
      ...(state.cancelled ? { cancelled: true } : {}),
    });
    state.resolve({
      text: collected.length > 0 ? collected : null,
      reason,
      ...(extra.error ? { error: extra.error } : {}),
      timedOut: state.timedOut,
      cancelled: state.cancelled || reason === 'cancelled',
    });
  }
}

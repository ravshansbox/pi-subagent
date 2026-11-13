import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentToolResult, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  formatReadLineRange,
  getMarkdownTheme,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text, TruncatedText } from '@earendil-works/pi-tui';
import { type Static, Type } from 'typebox';

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_BACKGROUND_JOBS = 5;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_BYTES_LIMIT = 1024 * 1024;
const STDERR_CAP = 50 * 1024;
const DEFAULT_MAX_DEPTH = 2;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
  contextWindow?: number,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.contextTokens && contextWindow) {
    const percent = ((usage.contextTokens / contextWindow) * 100).toFixed(0);
    parts.push(`${percent}%/${formatTokens(contextWindow)}`);
  }
  if (model) parts.push(model.replace(/^.*\//, '').replace(/^claude-/, ''));
  return parts.join(' ');
}

function shorten(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case 'bash': {
      const command = String(args['command'] || '...');
      const preview = shorten(command, 60);
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview);
    }
    case 'read': {
      const rawPath = String(args['file_path'] || args['path'] || '...');
      const filePath = shortenPath(rawPath);
      const lineRange = formatReadLineRange(args['offset'], args['limit']);
      let text = themeFg('accent', filePath);
      if (lineRange) {
        text += themeFg('warning', lineRange);
      }
      return themeFg('muted', 'read ') + text;
    }
    case 'write': {
      const rawPath = String(args['file_path'] || args['path'] || '...');
      const filePath = shortenPath(rawPath);
      const content = String(args['content'] || '');
      const lines = content.split('\n').length;
      let text = themeFg('muted', 'write ') + themeFg('accent', filePath);
      if (lines > 1) text += themeFg('dim', ` (${lines} lines)`);
      return text;
    }
    case 'edit': {
      const rawPath = String(args['file_path'] || args['path'] || '...');
      return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'ls': {
      const rawPath = String(args['path'] || '.');
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'find': {
      const pattern = String(args['pattern'] || '*');
      const rawPath = String(args['path'] || '.');
      return (
        themeFg('muted', 'find ') +
        themeFg('accent', pattern) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    case 'grep': {
      const pattern = String(args['pattern'] || '');
      const rawPath = String(args['path'] || '.');
      return (
        themeFg('muted', 'grep ') +
        themeFg('accent', `/${pattern}/`) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = shorten(argsStr, 50);
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`);
    }
  }
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens: number;
  turns: number;
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
}

interface SingleResult {
  label: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string | undefined;
  contextWindow?: number | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  step?: number | undefined;
}

interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain';
  results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'assistant') {
      const texts = msg.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      if (texts.length > 0) return texts.join('\n\n');
    }
  }
  return '';
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)';
  }
  return getFinalOutput(result.messages) || '(no output)';
}

function truncateOutput(output: string, maxBytes: number): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= maxBytes) return output;

  const truncated = Buffer.from(output)
    .toString('utf8', 0, maxBytes)
    .replace(/\uFFFD$/, '');
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') items.push({ type: 'text', text: part.text });
        else if (part.type === 'toolCall')
          items.push({ type: 'toolCall', name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
  return results;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: 'pi', args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface ParentSettings {
  provider?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  contextWindow?: number | undefined;
  depth: number;
  maxDepth: number;
}

interface SingleAgentOptions {
  defaultCwd: string;
  parent: ParentSettings;
  label: string;
  task: string;
  cwd?: string | undefined;
  step?: number | undefined;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdateCallback | undefined;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

async function runSingleAgent({
  defaultCwd,
  parent,
  label,
  task,
  cwd,
  step,
  signal,
  onUpdate,
  makeDetails,
}: SingleAgentOptions): Promise<SingleResult> {
  const args: string[] = ['--mode', 'json', '-p', '--no-session'];
  if (parent.provider && parent.model) {
    args.push('--provider', parent.provider, '--model', parent.model);
  }
  if (parent.thinkingLevel) args.push('--thinking', parent.thinkingLevel);
  const model = parent.provider && parent.model ? `${parent.provider}/${parent.model}` : undefined;

  const currentResult: SingleResult = {
    label,
    task,
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    model,
    contextWindow: parent.contextWindow,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: getFinalOutput(currentResult.messages) || '(running...)' }],
        details: makeDetails([{ ...currentResult, exitCode: -1 }]),
      });
    }
  };

  args.push(`Task: ${task}`);
  if (signal?.aborted) throw new Error('Subagent was aborted');
  let wasAborted = false;

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      env: {
        ...process.env,
        PI_SUBAGENT_DEPTH: String(parent.depth + 1),
        PI_SUBAGENT_MAX_DEPTH: String(parent.maxDepth),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let killTimer: NodeJS.Timeout | undefined;
    const killProc = () => {
      wasAborted = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, 5000);
    };
    signal?.addEventListener('abort', killProc, { once: true });
    const stopWatchingAbort = () => {
      signal?.removeEventListener('abort', killProc);
      clearTimeout(killTimer);
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: { type?: string; message?: Message };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === 'message_end' && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);

        if (msg.role === 'assistant') {
          currentResult.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            currentResult.usage.input += usage.input || 0;
            currentResult.usage.output += usage.output || 0;
            currentResult.usage.cacheRead += usage.cacheRead || 0;
            currentResult.usage.cacheWrite += usage.cacheWrite || 0;
            currentResult.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!currentResult.model && msg.model) currentResult.model = msg.model;
          if (msg.stopReason) currentResult.stopReason = msg.stopReason;
          if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
        }
        emitUpdate();
      }
    };

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    proc.stderr.on('data', (data) => {
      currentResult.stderr = (currentResult.stderr + data.toString()).slice(-STDERR_CAP);
    });

    proc.on('close', (code) => {
      stopWatchingAbort();
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 1);
    });

    proc.on('error', (error) => {
      stopWatchingAbort();
      currentResult.errorMessage = error.message;
      resolve(1);
    });
  });

  currentResult.exitCode = exitCode;
  if (wasAborted) throw new Error('Subagent was aborted');
  return currentResult;
}

const TaskItem = Type.Object({
  task: Type.String({ description: 'Task to delegate to the subagent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the subagent process' })),
});

const ChainItem = Type.Object({
  task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the subagent process' })),
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: 'Array of {task} for parallel execution' }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: 'Array of {task} for sequential execution' }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the subagent process (single mode)' }),
  ),
  maxOutputBytes: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_OUTPUT_BYTES_LIMIT,
      description: `Maximum bytes of output returned per subagent (default ${DEFAULT_MAX_OUTPUT_BYTES}). Raise it only when you need the full output.`,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'Run in the background and return at once. The result arrives later as a follow-up message.',
    }),
  ),
});

type SubagentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

const makeDetails =
  (mode: SubagentDetails['mode']) =>
  (results: SingleResult[]): SubagentDetails => ({ mode, results });

interface RunContext {
  defaultCwd: string;
  parent: ParentSettings;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdateCallback | undefined;
  limit: (output: string) => string;
}

async function runChain(
  chain: { task: string; cwd?: string | undefined }[],
  { defaultCwd, parent, signal, onUpdate, limit }: RunContext,
): Promise<SubagentResult> {
  const results: SingleResult[] = [];
  let previousOutput = '';

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]!;
    const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0];
          if (currentResult) {
            const allResults = [...results, currentResult];
            onUpdate({
              content: partial.content,
              details: makeDetails('chain')(allResults),
            });
          }
        }
      : undefined;

    const result = await runSingleAgent({
      defaultCwd,
      parent,
      label: `step ${i + 1}`,
      task: taskWithContext,
      cwd: step.cwd,
      step: i + 1,
      signal,
      onUpdate: chainUpdate,
      makeDetails: makeDetails('chain'),
    });
    results.push(result);

    if (isFailedResult(result)) {
      return {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${i + 1}: ${limit(getResultOutput(result))}`,
          },
        ],
        details: makeDetails('chain')(results),
        isError: true,
      };
    }
    previousOutput = limit(getFinalOutput(result.messages));
  }
  return {
    content: [{ type: 'text', text: previousOutput || '(no output)' }],
    details: makeDetails('chain')(results),
  };
}

async function runParallel(
  tasks: { task: string; cwd?: string | undefined }[],
  { defaultCwd, parent, signal, onUpdate, limit }: RunContext,
): Promise<SubagentResult> {
  if (tasks.length > MAX_PARALLEL_TASKS)
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: makeDetails('parallel')([]),
      isError: true,
    };

  const allResults: SingleResult[] = tasks.map((t, i) => ({
    label: `task ${i + 1}`,
    task: t.task,
    exitCode: -1,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
  }));

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: 'text',
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails('parallel')([...allResults]),
      });
    }
  };

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent({
      defaultCwd,
      parent,
      label: `task ${index + 1}`,
      task: t.task,
      cwd: t.cwd,
      signal,
      onUpdate: (partial) => {
        if (partial.details?.results[0]) {
          allResults[index] = { ...partial.details.results[0], exitCode: -1 };
          emitParallelUpdate();
        }
      },
      makeDetails: makeDetails('parallel'),
    });
    allResults[index] = result;
    emitParallelUpdate();
    return result;
  });

  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const summaries = results.map((r) => {
    const output = limit(getResultOutput(r));
    const status = isFailedResult(r)
      ? `failed${r.stopReason && r.stopReason !== 'stop' ? ` (${r.stopReason})` : ''}`
      : 'completed';
    return `### [${r.label}] ${status}\n\n${output}`;
  });
  return {
    content: [
      {
        type: 'text',
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`,
      },
    ],
    details: makeDetails('parallel')(results),
  };
}

async function runSingle(
  task: string,
  cwd: string | undefined,
  { defaultCwd, parent, signal, onUpdate, limit }: RunContext,
): Promise<SubagentResult> {
  const result = await runSingleAgent({
    defaultCwd,
    parent,
    label: 'subagent',
    task,
    cwd,
    signal,
    onUpdate,
    makeDetails: makeDetails('single'),
  });
  if (isFailedResult(result)) {
    const reason = result.stopReason && result.stopReason !== 'stop' ? result.stopReason : 'failed';
    return {
      content: [{ type: 'text', text: `Agent ${reason}: ${limit(getResultOutput(result))}` }],
      details: makeDetails('single')([result]),
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: limit(getFinalOutput(result.messages)) || '(no output)' }],
    details: makeDetails('single')([result]),
  };
}

async function runSubagent(
  params: Static<typeof SubagentParams>,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  ctx: ExtensionContext,
  nesting: { depth: number; maxDepth: number },
): Promise<SubagentResult> {
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const run: RunContext = {
    defaultCwd: ctx.cwd,
    parent: {
      ...nesting,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      contextWindow: ctx.model?.contextWindow,
      thinkingLevel: ctx.thinkingLevel,
    },
    signal,
    onUpdate,
    limit: (output) => truncateOutput(output, maxOutputBytes),
  };

  const { chain = [], tasks = [], task } = params;
  if (chain.length > 0 && tasks.length === 0 && !task) return runChain(chain, run);
  if (tasks.length > 0 && chain.length === 0 && !task) return runParallel(tasks, run);
  if (task && chain.length === 0 && tasks.length === 0) return runSingle(task, params.cwd, run);
  return {
    content: [{ type: 'text', text: 'Invalid parameters. Provide exactly one mode.' }],
    details: makeDetails('single')([]),
    isError: true,
  };
}

function isValidMaxDepth(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export default function (pi: ExtensionAPI) {
  const depth = Number(process.env['PI_SUBAGENT_DEPTH']) || 0;
  const inheritedMaxDepthText = process.env['PI_SUBAGENT_MAX_DEPTH'];
  const inheritedMaxDepth =
    inheritedMaxDepthText && isValidMaxDepth(Number(inheritedMaxDepthText))
      ? Number(inheritedMaxDepthText)
      : undefined;
  const effectiveMaxDepth = inheritedMaxDepth ?? DEFAULT_MAX_DEPTH;
  if (effectiveMaxDepth > 0 && depth >= effectiveMaxDepth) return;

  const getConfiguredMaxDepth = () => {
    const settings = pi.getSettings() as { subagent?: { maxDepth?: unknown } };
    return settings.subagent?.maxDepth;
  };

  const getNesting = () => {
    if (inheritedMaxDepth !== undefined) return { depth, maxDepth: inheritedMaxDepth };
    const maxDepth = getConfiguredMaxDepth();
    return { depth, maxDepth: isValidMaxDepth(maxDepth) ? maxDepth : DEFAULT_MAX_DEPTH };
  };

  pi.on('session_start', (_event, ctx) => {
    if (depth > 0 || !ctx.hasUI) return;
    const maxDepth = getConfiguredMaxDepth();
    if (maxDepth === undefined || isValidMaxDepth(maxDepth)) return;
    ctx.ui.notify(
      `subagent.maxDepth must be a whole number of 0 or more. Using the default of ${DEFAULT_MAX_DEPTH}.`,
      'error',
    );
  });

  const backgroundJobs = new Map<number, AbortController>();
  let nextJobId = 1;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const count = backgroundJobs.size;
    ctx.ui.setStatus(
      'subagent',
      count > 0 ? `${count} subagent${count > 1 ? 's' : ''}` : undefined,
    );
  };

  pi.on('session_shutdown', () => {
    for (const controller of backgroundJobs.values()) controller.abort();
    backgroundJobs.clear();
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate tasks to subagents with isolated context.',
      'Modes: single (task), parallel (tasks array), chain (sequential with {previous} placeholder).',
      'Subagents use the current provider, model and thinking level.',
    ].join(' '),
    parameters: depth > 0 ? Type.Omit(SubagentParams, ['background']) : SubagentParams,

    async execute(_toolCallId, params: Static<typeof SubagentParams>, signal, onUpdate, ctx) {
      const nesting = getNesting();
      if (depth > 0 || !params.background)
        return runSubagent(params, signal, onUpdate, ctx, nesting);

      if (backgroundJobs.size >= MAX_BACKGROUND_JOBS)
        return {
          content: [
            {
              type: 'text',
              text: `${MAX_BACKGROUND_JOBS} background subagent jobs are already running. Wait for one to finish.`,
            },
          ],
          details: { mode: 'single', results: [] },
          isError: true,
        };

      const jobId = nextJobId++;
      const controller = new AbortController();
      backgroundJobs.set(jobId, controller);
      updateStatus(ctx);
      runSubagent(params, controller.signal, undefined, ctx, nesting).then(
        (result) => {
          backgroundJobs.delete(jobId);
          updateStatus(ctx);
          const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
          pi.sendMessage(
            {
              customType: 'subagent-result',
              content: `Background subagent job ${jobId} ${result.isError ? 'failed' : 'finished'}:\n\n${output}`,
              display: true,
            },
            { triggerTurn: true, deliverAs: 'followUp' },
          );
        },
        () => backgroundJobs.delete(jobId),
      );

      return {
        content: [
          {
            type: 'text',
            text: `Started background subagent job ${jobId}. Its result will arrive as a follow-up message.`,
          },
        ],
        details: { mode: 'single', results: [] },
      };
    },

    renderCall(args, theme) {
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg('toolTitle', theme.bold('subagent ')) +
          theme.fg('accent', `chain (${args.chain.length} steps)`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i]!;
          const cleanTask = step.task.replace(/\{previous\}/g, '').trim();
          const preview = shorten(cleanTask, 40);
          text += '\n  ' + theme.fg('muted', `${i + 1}.`) + theme.fg('dim', ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg('muted', `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg('toolTitle', theme.bold('subagent ')) +
          theme.fg('accent', `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = shorten(t.task, 40);
          text += `\n  ${theme.fg('dim', preview)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const preview = args.task ? shorten(args.task, 60) : '...';
      let text = theme.fg('toolTitle', theme.bold('subagent'));
      text += `\n  ${theme.fg('dim', preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      const resultStatus = (r: SingleResult) => {
        if (r.exitCode === -1) return 'running';
        return isFailedResult(r) ? 'failed' : 'done';
      };

      const groupStatus = (results: SingleResult[]) => {
        if (results.some((r) => r.exitCode === -1)) return 'running';
        return results.some(isFailedResult) ? 'failed' : 'done';
      };

      const withUsage = (text: string, usageStr: string) =>
        usageStr ? text + theme.fg('dim', ` · ${usageStr}`) : text;

      const collapsedLine = (r: SingleResult, label: string) => {
        let text = `${resultStatus(r)} ${label}`;
        if (isFailedResult(r) && r.exitCode !== -1) {
          if (r.stopReason) text += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
          const error = (r.errorMessage || r.stderr).trim().split('\n')[0];
          if (error) text += ` ${theme.fg('error', error)}`;
          return text;
        }
        return withUsage(text, formatUsageStats(r.usage, r.model, r.contextWindow));
      };

      const collapsedList = (header: string, results: SingleResult[]) => {
        const container = new Container();
        container.addChild(new TruncatedText(header, 0, 0));
        for (const r of results)
          container.addChild(
            new TruncatedText(`  ${collapsedLine(r, theme.fg('accent', r.label))}`, 0, 0),
          );
        return container;
      };

      const aggregateUsage = (results: SingleResult[]) => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.turns += r.usage.turns;
        }
        return total;
      };

      const addToolCalls = (container: Container, displayItems: DisplayItem[]) => {
        for (const item of displayItems) {
          if (item.type === 'toolCall')
            container.addChild(
              new Text(
                theme.fg('muted', '→ ') +
                  formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                0,
                0,
              ),
            );
        }
      };

      const expandedList = (
        header: string,
        results: SingleResult[],
        heading: (r: SingleResult) => string,
      ) => {
        const container = new Container();
        container.addChild(new Text(header, 0, 0));

        for (const r of results) {
          const finalOutput = getFinalOutput(r.messages);
          container.addChild(new Spacer(1));
          container.addChild(new Text(`${heading(r)} ${resultStatus(r)}`, 0, 0));
          container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0));
          addToolCalls(container, getDisplayItems(r.messages));
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }
          const usageStr = formatUsageStats(r.usage, r.model, r.contextWindow);
          if (usageStr) container.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
        }

        const usageStr = formatUsageStats(aggregateUsage(results));
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0));
        }
        return container;
      };

      if (details.mode === 'single' && details.results.length === 1) {
        const r = details.results[0]!;
        const isError = r.exitCode !== -1 && isFailedResult(r);
        const statusText = resultStatus(r);
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${statusText} ${theme.fg('toolTitle', theme.bold(r.label))}`;
          if (isError && r.stopReason) header += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0));
          container.addChild(new Text(theme.fg('dim', r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0));
          } else {
            addToolCalls(container, displayItems);
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
          }
          const usageStr = formatUsageStats(r.usage, r.model, r.contextWindow);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
          }
          return container;
        }

        return new TruncatedText(
          collapsedLine(r, theme.fg('toolTitle', theme.bold(r.label))),
          0,
          0,
        );
      }

      if (details.mode === 'chain') {
        const successCount = details.results.filter((r) => !isFailedResult(r)).length;
        const statusText = groupStatus(details.results);

        const header =
          statusText +
          ' ' +
          theme.fg('toolTitle', theme.bold('chain ')) +
          theme.fg('accent', `${successCount}/${details.results.length} steps`);

        if (expanded)
          return expandedList(header, details.results, (r) =>
            theme.fg('muted', `─── Step ${r.step}`),
          );
        const totalUsage = formatUsageStats(aggregateUsage(details.results));
        return collapsedList(
          withUsage(header, totalUsage && `Total: ${totalUsage}`),
          details.results,
        );
      }

      if (details.mode === 'parallel') {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter(
          (r) => r.exitCode !== -1 && !isFailedResult(r),
        ).length;
        const failCount = details.results.filter(
          (r) => r.exitCode !== -1 && isFailedResult(r),
        ).length;
        const isRunning = running > 0;
        const statusText = groupStatus(details.results);
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        const header = `${statusText} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`;

        if (expanded && !isRunning)
          return expandedList(
            header,
            details.results,
            (r) => theme.fg('muted', '─── ') + theme.fg('accent', r.label),
          );
        const totalUsage = isRunning ? '' : formatUsageStats(aggregateUsage(details.results));
        return collapsedList(
          withUsage(header, totalUsage && `Total: ${totalUsage}`),
          details.results,
        );
      }

      const text = result.content[0];
      return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
    },
  });
}

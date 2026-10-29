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
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
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
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
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
      for (const part of msg.content) {
        if (part.type === 'text') return part.text;
      }
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

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  const truncated = Buffer.from(output)
    .toString('utf8', 0, PER_TASK_OUTPUT_CAP)
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
}

async function runSingleAgent(
  defaultCwd: string,
  parent: ParentSettings,
  label: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 0,
      turns: 0,
    },
    model,
    contextWindow: parent.contextWindow,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: getFinalOutput(currentResult.messages) || '(running...)' }],
        details: makeDetails([currentResult]),
      });
    }
  };

  args.push(`Task: ${task}`);
  let wasAborted = false;

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
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
      currentResult.stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 1);
    });

    proc.on('error', (error) => {
      currentResult.errorMessage = error.message;
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener('abort', killProc, { once: true });
    }
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
  background: Type.Optional(
    Type.Boolean({
      description:
        'Run in the background and return at once. The result arrives later as a follow-up message.',
    }),
  ),
});

async function runSubagent(
  params: Static<typeof SubagentParams>,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
  const parent: ParentSettings = {
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    contextWindow: ctx.model?.contextWindow,
    thinkingLevel: ctx.thinkingLevel,
  };

  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasTasks = (params.tasks?.length ?? 0) > 0;
  const hasSingle = Boolean(params.task);
  const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

  const makeDetails =
    (mode: 'single' | 'parallel' | 'chain') =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      results,
    });

  if (modeCount !== 1) {
    return {
      content: [{ type: 'text', text: 'Invalid parameters. Provide exactly one mode.' }],
      details: makeDetails('single')([]),
    };
  }

  if (params.chain && params.chain.length > 0) {
    const results: SingleResult[] = [];
    let previousOutput = '';

    for (let i = 0; i < params.chain.length; i++) {
      const step = params.chain[i]!;
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

      const result = await runSingleAgent(
        ctx.cwd,
        parent,
        `step ${i + 1}`,
        taskWithContext,
        step.cwd,
        i + 1,
        signal,
        chainUpdate,
        makeDetails('chain'),
      );
      results.push(result);

      const isError = isFailedResult(result);
      if (isError) {
        const errorMsg = getResultOutput(result);
        return {
          content: [
            {
              type: 'text',
              text: `Chain stopped at step ${i + 1}: ${errorMsg}`,
            },
          ],
          details: makeDetails('chain')(results),
          isError: true,
        };
      }
      previousOutput = getFinalOutput(result.messages);
    }
    return {
      content: [
        {
          type: 'text',
          text: getFinalOutput(results[results.length - 1]!.messages) || '(no output)',
        },
      ],
      details: makeDetails('chain')(results),
    };
  }

  if (params.tasks && params.tasks.length > 0) {
    if (params.tasks.length > MAX_PARALLEL_TASKS)
      return {
        content: [
          {
            type: 'text',
            text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
          },
        ],
        details: makeDetails('parallel')([]),
      };

    const allResults: SingleResult[] = Array.from({ length: params.tasks.length });

    for (let i = 0; i < params.tasks.length; i++) {
      allResults[i] = {
        label: `task ${i + 1}`,
        task: params.tasks[i]!.task,
        exitCode: -1,
        messages: [],
        stderr: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          contextTokens: 0,
          turns: 0,
        },
      };
    }

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

    const results = await mapWithConcurrencyLimit(
      params.tasks,
      MAX_CONCURRENCY,
      async (t, index) => {
        const result = await runSingleAgent(
          ctx.cwd,
          parent,
          `task ${index + 1}`,
          t.task,
          t.cwd,
          undefined,
          signal,
          (partial) => {
            if (partial.details?.results[0]) {
              allResults[index] = { ...partial.details.results[0], exitCode: -1 };
              emitParallelUpdate();
            }
          },
          makeDetails('parallel'),
        );
        allResults[index] = result;
        emitParallelUpdate();
        return result;
      },
    );

    const successCount = results.filter((r) => !isFailedResult(r)).length;
    const summaries = results.map((r) => {
      const output = truncateParallelOutput(getResultOutput(r));
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

  const result = await runSingleAgent(
    ctx.cwd,
    parent,
    'subagent',
    params.task!,
    params.cwd,
    undefined,
    signal,
    onUpdate,
    makeDetails('single'),
  );
  if (isFailedResult(result)) {
    return {
      content: [
        {
          type: 'text',
          text: `Agent ${result.stopReason || 'failed'}: ${getResultOutput(result)}`,
        },
      ],
      details: makeDetails('single')([result]),
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
    details: makeDetails('single')([result]),
  };
}

export default function (pi: ExtensionAPI) {
  const backgroundJobs = new Map<number, AbortController>();
  let nextJobId = 1;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const count = backgroundJobs.size;
    ctx.ui.setStatus(
      'subagent',
      count > 0 ? `⏳ ${count} subagent${count > 1 ? 's' : ''}` : undefined,
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
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!params.background) return runSubagent(params, signal, onUpdate, ctx);

      const jobId = nextJobId++;
      const controller = new AbortController();
      backgroundJobs.set(jobId, controller);
      updateStatus(ctx);
      runSubagent(params, controller.signal, undefined, ctx).then(
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
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
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
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg('dim', preview)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : '...';
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

      const resultIcon = (r: SingleResult) =>
        r.exitCode === -1
          ? theme.fg('warning', '⏳')
          : isFailedResult(r)
            ? theme.fg('error', '✗')
            : theme.fg('success', '✓');

      const withUsage = (text: string, usageStr: string) =>
        usageStr ? text + theme.fg('dim', ` · ${usageStr}`) : text;

      const collapsedLine = (r: SingleResult, label: string) => {
        let text = `${resultIcon(r)} ${label}`;
        if (isFailedResult(r) && r.exitCode !== -1) {
          if (r.stopReason) text += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
          const error = (r.errorMessage || r.stderr).trim().split('\n')[0];
          if (error) text += ` ${theme.fg('error', error)}`;
          return text;
        }
        const lastToolCall = getDisplayItems(r.messages)
          .filter((item) => item.type === 'toolCall')
          .at(-1);
        if (lastToolCall)
          text += ` ${theme.fg('muted', '→ ')}${formatToolCall(lastToolCall.name, lastToolCall.args, theme.fg.bind(theme))}`;
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

      if (details.mode === 'single' && details.results.length === 1) {
        const r = details.results[0]!;
        const isError = isFailedResult(r);
        const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓');
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.label))}`;
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

      if (details.mode === 'chain') {
        const successCount = details.results.filter((r) => !isFailedResult(r)).length;
        const icon =
          successCount === details.results.length
            ? theme.fg('success', '✓')
            : theme.fg('error', '✗');

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                ' ' +
                theme.fg('toolTitle', theme.bold('chain ')) +
                theme.fg('accent', `${successCount}/${details.results.length} steps`),
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon = isFailedResult(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(`${theme.fg('muted', `─── Step ${r.step}`)} ${rIcon}`, 0, 0),
            );
            container.addChild(
              new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0),
            );

            for (const item of displayItems) {
              if (item.type === 'toolCall') {
                container.addChild(
                  new Text(
                    theme.fg('muted', '→ ') +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
              }
            }

            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }

            const stepUsage = formatUsageStats(r.usage, r.model, r.contextWindow);
            if (stepUsage) container.addChild(new Text(theme.fg('dim', stepUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        const header =
          icon +
          ' ' +
          theme.fg('toolTitle', theme.bold('chain ')) +
          theme.fg('accent', `${successCount}/${details.results.length} steps`);
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
        const icon = isRunning
          ? theme.fg('warning', '⏳')
          : failCount > 0
            ? theme.fg('warning', '◐')
            : theme.fg('success', '✓');
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`,
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon = isFailedResult(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(`${theme.fg('muted', '─── ') + theme.fg('accent', r.label)} ${rIcon}`, 0, 0),
            );
            container.addChild(
              new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0),
            );

            for (const item of displayItems) {
              if (item.type === 'toolCall') {
                container.addChild(
                  new Text(
                    theme.fg('muted', '→ ') +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
              }
            }

            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }

            const taskUsage = formatUsageStats(r.usage, r.model, r.contextWindow);
            if (taskUsage) container.addChild(new Text(theme.fg('dim', taskUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        const header = `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`;
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

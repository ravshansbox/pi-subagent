/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  getMarkdownTheme,
  type Theme,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Container,
  type Focusable,
  Markdown,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  type TUI,
} from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { type AgentConfig, type AgentScope, discoverAgents } from './src/agents.ts';

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_FINISHED_RUNS = 20;
const ROSTER_WIDGET_KEY = 'subagent-roster';
const ROSTER_REFRESH_MS = 100;
const ROSTER_TOOL_WIDTH = 60;
const PICKER_MIN_HEIGHT = 6;
const PICKER_STDERR_LINES = 10;

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
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
  thinkingLevel?: string,
  contextWindow?: number,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    let contextDisplay = formatTokens(usage.contextTokens);
    if (contextWindow) {
      const percent = ((usage.contextTokens / contextWindow) * 100).toFixed(1);
      contextDisplay = `${percent}%/${formatTokens(contextWindow)}`;
    }
    parts.push(contextDisplay);
  }
  const modelParts = model?.split('/');
  const modelDisplay =
    modelParts?.length === 2 ? `(${modelParts[0]}) ${modelParts[1]}` : model;
  if (modelDisplay) parts.push(modelDisplay);
  if (thinkingLevel === 'off') parts.push(`• thinking off`);
  else if (thinkingLevel) parts.push(`• ${thinkingLevel}`);
  return parts.join(' ');
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case 'bash': {
      const command = (args['command'] as string) || '...';
      return themeFg('muted', '$ ') + themeFg('toolOutput', command);
    }
    case 'read': {
      const rawPath = (args['file_path'] || args['path'] || '...') as string;
      const filePath = shortenPath(rawPath);
      const offset = args['offset'] as number | undefined;
      const limit = args['limit'] as number | undefined;
      const startLine = offset ?? 1;
      const endLine = limit !== undefined ? startLine + limit - 1 : '';
      let text = themeFg('accent', filePath);
      if (offset !== undefined || limit !== undefined) {
        text += themeFg(
          'warning',
          `:${startLine}${endLine ? `-${endLine}` : ''}`,
        );
      }
      return themeFg('muted', 'read ') + text;
    }
    case 'write': {
      const rawPath = (args['file_path'] || args['path'] || '...') as string;
      const filePath = shortenPath(rawPath);
      const content = (args['content'] || '') as string;
      const lines = content.split('\n').length;
      let text = themeFg('muted', 'write ') + themeFg('accent', filePath);
      if (lines > 1) text += themeFg('dim', ` (${lines} lines)`);
      return text;
    }
    case 'edit': {
      const rawPath = (args['file_path'] || args['path'] || '...') as string;
      return (
        themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath))
      );
    }
    case 'ls': {
      const rawPath = (args['path'] || '.') as string;
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'find': {
      const pattern = (args['pattern'] || '*') as string;
      const rawPath = (args['path'] || '.') as string;
      return (
        themeFg('muted', 'find ') +
        themeFg('accent', pattern) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    case 'grep': {
      const pattern = (args['pattern'] || '') as string;
      const rawPath = (args['path'] || '.') as string;
      return (
        themeFg('muted', 'grep ') +
        themeFg('accent', `/${pattern}/`) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      return themeFg('accent', toolName) + themeFg('dim', ` ${argsStr}`);
    }
  }
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: 'packaged' | 'user' | 'project' | 'unknown';
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string | undefined;
  contextWindow?: number | undefined;
  thinkingLevel?: string | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  step?: number | undefined;
}

interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  packagedAgentsDir: string | null;
  results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
  for (const msg of [...messages].reverse()) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') return part.text;
      }
    }
  }
  return '';
}

type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') items.push({ type: 'text', text: part.text });
        else if (part.type === 'toolCall')
          items.push({
            type: 'toolCall',
            name: part.name,
            args: part.arguments,
          });
      }
    }
  }
  return items;
}

type RunStatus = 'running' | 'done' | 'failed';

interface RunEntry {
  id: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  result: SingleResult;
}

let nextRunId = 1;
const runs: RunEntry[] = [];
const runListeners = new Set<() => void>();

function notifyRunListeners(): void {
  for (const listener of runListeners) listener();
}

function subscribeRuns(listener: () => void): () => void {
  runListeners.add(listener);
  return () => {
    runListeners.delete(listener);
  };
}

function listRuns(): readonly RunEntry[] {
  return runs;
}

function startRun(result: SingleResult): RunEntry {
  const entry: RunEntry = {
    id: String(nextRunId++),
    status: 'running',
    startedAt: Date.now(),
    result,
  };
  runs.push(entry);
  let finished = runs.filter((run) => run.status !== 'running').length;
  while (finished > MAX_FINISHED_RUNS) {
    const oldest = runs.findIndex((run) => run.status !== 'running');
    if (oldest === -1) break;
    runs.splice(oldest, 1);
    finished--;
  }
  notifyRunListeners();
  return entry;
}

function endRun(entry: RunEntry, failed: boolean): void {
  entry.status = failed ? 'failed' : 'done';
  entry.endedAt = Date.now();
  notifyRunListeners();
}

function getLastToolCall(
  messages: Message[],
): { name: string; args: Record<string, unknown> } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part?.type === 'toolCall')
        return { name: part.name, args: part.arguments };
    }
  }
  return undefined;
}

function formatRunStats(result: SingleResult): string {
  const parts: string[] = [
    result.usage.turns
      ? `${result.usage.turns} turn${result.usage.turns > 1 ? 's' : ''}`
      : 'starting',
  ];
  if (result.usage.input) parts.push(`↑${formatTokens(result.usage.input)}`);
  if (result.usage.output) parts.push(`↓${formatTokens(result.usage.output)}`);
  if (result.usage.cost) parts.push(`$${result.usage.cost.toFixed(4)}`);
  return parts.join(' ');
}

function formatLastToolCall(result: SingleResult): string | undefined {
  const tool = getLastToolCall(result.messages);
  if (!tool) return undefined;
  const plain = formatToolCall(tool.name, tool.args, (_color, text) => text);
  return truncateToWidth(plain.replace(/\s+/g, ' '), ROSTER_TOOL_WIDTH);
}

function renderRosterLines(theme: Theme): string[] {
  const active = listRuns().filter((run) => run.status === 'running');
  if (active.length === 0) return [];
  const lines = [
    theme.fg('toolTitle', theme.bold('subagent ')) +
      theme.fg('muted', `${active.length} running`),
  ];
  for (const run of active) {
    let line =
      `${theme.fg('warning', '▸')} ` +
      theme.fg('accent', run.result.agent) +
      ` ${theme.fg('dim', formatRunStats(run.result))}`;
    const tool = formatLastToolCall(run.result);
    if (tool) line += `  ${theme.fg('muted', tool)}`;
    lines.push(line);
  }
  return lines;
}

function bindRosterWidget(ui: ExtensionUIContext): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;

  const clear = () => {
    if (!shown) return;
    ui.setWidget(ROSTER_WIDGET_KEY, undefined);
    shown = false;
  };

  const render = () => {
    timer = null;
    if (listRuns().every((run) => run.status !== 'running')) {
      clear();
      return;
    }
    ui.setWidget(
      ROSTER_WIDGET_KEY,
      (_tui, theme) => new Text(renderRosterLines(theme).join('\n'), 0, 0),
      { placement: 'belowEditor' },
    );
    shown = true;
  };

  const unsubscribe = subscribeRuns(() => {
    if (timer) return;
    timer = setTimeout(render, ROSTER_REFRESH_MS);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    clear();
  };
}

function formatRunIcon(entry: RunEntry, theme: Theme): string {
  if (entry.status === 'running') return theme.fg('warning', '▸');
  return entry.status === 'failed'
    ? theme.fg('error', '✗')
    : theme.fg('success', '✓');
}

function formatRunElapsed(entry: RunEntry): string {
  const end = entry.endedAt ?? Date.now();
  return `${Math.round((end - entry.startedAt) / 1000)}s`;
}

class RunPickerOverlay implements Component, Focusable {
  focused = false;
  private view: 'list' | 'log' = 'list';
  private selected = 0;
  private scroll = 0;
  private follow = true;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (result: undefined) => void,
  ) {
    this.unsubscribe = subscribeRuns(() => tui.requestRender());
  }

  dispose(): void {
    this.unsubscribe();
  }

  invalidate(): void {}

  private viewportHeight(): number {
    return Math.max(
      PICKER_MIN_HEIGHT,
      Math.floor(this.tui.terminal.rows * 0.7) - 4,
    );
  }

  handleInput(data: string): void {
    const entries = listRuns();
    this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));

    if (matchesKey(data, 'escape')) {
      if (this.view === 'log') {
        this.view = 'list';
        this.scroll = 0;
        this.follow = true;
      } else this.done(undefined);
      this.tui.requestRender();
      return;
    }

    if (this.view === 'list') {
      if (matchesKey(data, 'up')) this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, 'down'))
        this.selected = Math.min(entries.length - 1, this.selected + 1);
      else if (matchesKey(data, 'return') && entries.length > 0) {
        this.view = 'log';
        this.scroll = 0;
        this.follow = true;
      }
      this.tui.requestRender();
      return;
    }

    const height = this.viewportHeight();
    const max = Math.max(0, this.logLines().length - height);
    if (matchesKey(data, 'up')) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, 'down'))
      this.scroll = Math.min(max, this.scroll + 1);
    else if (matchesKey(data, 'pageUp'))
      this.scroll = Math.max(0, this.scroll - height);
    else if (matchesKey(data, 'pageDown'))
      this.scroll = Math.min(max, this.scroll + height);
    else if (matchesKey(data, 'home')) this.scroll = 0;
    else if (matchesKey(data, 'end')) this.scroll = max;
    this.follow = this.scroll >= max;
    this.tui.requestRender();
  }

  private listLines(): string[] {
    const entries = listRuns();
    if (entries.length === 0)
      return [this.theme.fg('muted', '(no subagent runs yet)')];
    return entries.map((entry, index) => {
      const marker =
        index === this.selected ? this.theme.fg('accent', '›') : ' ';
      const tool = formatLastToolCall(entry.result);
      const stats = `${formatRunStats(entry.result)} ${formatRunElapsed(entry)}`;
      let line =
        `${marker} ${formatRunIcon(entry, this.theme)} ` +
        this.theme.fg('accent', entry.result.agent) +
        ` ${this.theme.fg('dim', stats)}`;
      if (tool) line += `  ${this.theme.fg('muted', tool)}`;
      return line;
    });
  }

  private logLines(): string[] {
    const entry = listRuns()[this.selected];
    if (!entry) return [this.theme.fg('muted', '(no subagent runs yet)')];
    const theme = this.theme;
    const result = entry.result;
    const lines: string[] = [
      theme.fg('muted', 'Task: ') + theme.fg('dim', result.task),
      '',
    ];
    for (const item of getDisplayItems(result.messages)) {
      if (item.type === 'toolCall')
        lines.push(
          theme.fg('muted', '→ ') +
            formatToolCall(item.name, item.args, theme.fg.bind(theme)),
        );
      else
        for (const line of item.text.split('\n'))
          lines.push(theme.fg('toolOutput', line));
    }
    if (result.errorMessage)
      lines.push('', theme.fg('error', `Error: ${result.errorMessage}`));
    if (result.stderr.trim()) {
      lines.push('', theme.fg('error', 'stderr:'));
      for (const line of result.stderr
        .trim()
        .split('\n')
        .slice(-PICKER_STDERR_LINES))
        lines.push(theme.fg('error', line));
    }
    const usage = formatUsageStats(
      result.usage,
      result.model,
      result.thinkingLevel,
      result.contextWindow,
    );
    if (usage) lines.push('', theme.fg('dim', usage));
    return lines;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(20, width - 4);
    const height = this.viewportHeight();
    const isLog = this.view === 'log';
    const entries = listRuns();
    const selectedEntry = entries[this.selected];

    const title = isLog
      ? `subagent log · ${selectedEntry?.result.agent ?? '(none)'}`
      : `subagent runs · ${entries.length}`;
    const hint = isLog
      ? '↑↓ scroll · esc back'
      : '↑↓ select · enter open · esc close';

    const all = isLog ? this.logLines() : this.listLines();
    let start = 0;
    if (all.length > height) {
      const max = all.length - height;
      if (isLog) {
        if (this.follow) this.scroll = max;
        start = Math.min(this.scroll, max);
      } else start = Math.min(Math.max(0, this.selected - height + 1), max);
    }
    const body = all.slice(start, start + height);

    const pad = (text: string) => truncateToWidth(text, inner, '…', true);
    const border = (text: string) =>
      theme.fg('borderMuted', text.padEnd(inner + 4, '─'));

    return [
      border(`┌─ ${theme.fg('toolTitle', theme.bold(title))} `),
      ...body.map(
        (line) =>
          `${theme.fg('borderMuted', '│')} ${pad(line)} ${theme.fg('borderMuted', '│')}`,
      ),
      border(`└─ ${theme.fg('muted', hint)} `),
    ];
  }
}

async function openRunPicker(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('Subagent runs need the interactive TUI.', 'warning');
    return;
  }
  if (listRuns().length === 0) {
    ctx.ui.notify('No subagent runs yet.', 'info');
    return;
  }
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new RunPickerOverlay(tui, theme, done),
    {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '80%', maxHeight: '80%' },
      onHandle: (handle) => handle.focus(),
    },
  );
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as TIn, current);
    }
  };
  const workers: Promise<void>[] = [];
  for (let worker = 0; worker < limit; worker++) workers.push(runWorker());
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'pi-subagent-'),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

async function getPiInvocation(
  args: string[],
): Promise<{ command: string; args: string[] }> {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript) {
    try {
      await fs.promises.access(currentScript);
      return { command: process.execPath, args: [currentScript, ...args] };
    } catch {
      // Script path is not accessible; fall through to runtime detection.
    }
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: 'pi', args };
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Rolling single-row implementation: only the previous row is needed.
  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);

  for (let i = 1; i <= b.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= a.length; j++) {
      const substitution =
        (previous[j - 1] ?? 0) + (b[i - 1] === a[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }

  return previous[a.length] ?? 0;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  parentModel: { provider?: string; id?: string } | undefined,
  parentThinkingLevel: string | undefined,
  resolveModel: (
    model: string | undefined,
  ) => { contextWindow?: number; reasoning?: boolean } | undefined,
): Promise<SingleResult> {
  // Mirror pi's footer: only surface a thinking level for reasoning-capable models.
  const displayThinkingLevel = (
    model: string | undefined,
  ): string | undefined => {
    const resolved = resolveModel(model);
    return resolved && !resolved.reasoning ? undefined : parentThinkingLevel;
  };
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none';
    // Find closest match by Levenshtein-like distance
    let closest = '';
    let closestDist = Infinity;
    for (const a of agents) {
      const dist = levenshtein(agentName.toLowerCase(), a.name.toLowerCase());
      if (dist < closestDist) {
        closestDist = dist;
        closest = a.name;
      }
    }
    const suggestion =
      closestDist <= 3 && closest !== agentName
        ? ` Did you mean "${closest}"?`
        : '';
    return {
      agent: agentName,
      agentSource: 'unknown',
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.${suggestion}`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args: string[] = ['--mode', 'json', '-p', '--no-session'];
  if (agent.model) {
    args.push('--model', agent.model);
  } else if (parentModel?.id) {
    if (parentModel.provider) args.push('--provider', parentModel.provider);
    args.push('--model', parentModel.id);
  }
  if (parentThinkingLevel) args.push('--thinking', parentThinkingLevel);
  if (agent.tools && agent.tools.length > 0)
    args.push('--tools', agent.tools.join(','));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const initialModel =
    agent.model ||
    (parentModel?.provider && parentModel?.id
      ? `${parentModel.provider}/${parentModel.id}`
      : parentModel?.id);
  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: initialModel,
    contextWindow: resolveModel(initialModel)?.contextWindow,
    thinkingLevel: displayThinkingLevel(initialModel),
    step,
  };

  const runEntry = startRun(currentResult);
  let runFailed = true;

  const emitUpdate = () => {
    notifyRunListeners();
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: 'text',
            text: getFinalOutput(currentResult.messages) || '(running...)',
          },
        ],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push('--append-system-prompt', tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>(async (resolve) => {
      const invocation = await getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buffer = '';

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
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
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (msg.model) {
              currentResult.model = msg.provider
                ? `${msg.provider}/${msg.model}`
                : msg.model;
              currentResult.contextWindow = resolveModel(
                currentResult.model,
              )?.contextWindow;
              currentResult.thinkingLevel = displayThinkingLevel(
                currentResult.model,
              );
            }
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === 'tool_result_end' && event.message) {
          currentResult.messages.push(event.message as Message);
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
        resolve(code ?? 0);
      });

      proc.on('error', () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener('abort', killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error('Subagent was aborted');
    runFailed =
      currentResult.exitCode !== 0 ||
      currentResult.stopReason === 'error' ||
      currentResult.stopReason === 'aborted';
    return currentResult;
  } finally {
    endRun(runEntry, runFailed);
    if (tmpPromptPath)
      try {
        await fs.promises.unlink(tmpPromptPath);
      } catch {
        // Best-effort cleanup of the temp prompt file.
      }
    if (tmpPromptDir)
      try {
        await fs.promises.rmdir(tmpPromptDir);
      } catch {
        // Best-effort cleanup of the temp prompt directory.
      }
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process' }),
  ),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({
    description: 'Task with optional {previous} placeholder for prior output',
  }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process' }),
  ),
});

const AgentScopeSchema = Type.Unsafe<AgentScope>({
  type: 'string',
  enum: ['user', 'project', 'both'],
  description:
    'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: 'user',
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: 'Name of the agent to invoke (for single mode)',
    }),
  ),
  task: Type.Optional(
    Type.String({ description: 'Task to delegate (for single mode)' }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: 'Array of {agent, task} for parallel execution',
    }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: 'Array of {agent, task} for sequential execution',
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: 'Prompt before running project-local agents. Default: true.',
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for the agent process (single mode)',
    }),
  ),
});

export default async function (pi: ExtensionAPI) {
  let unbindRoster: (() => void) | null = null;

  pi.on('session_start', (_event, ctx) => {
    unbindRoster?.();
    unbindRoster = ctx.mode === 'tui' ? bindRosterWidget(ctx.ui) : null;
  });

  pi.on('session_shutdown', () => {
    unbindRoster?.();
    unbindRoster = null;
  });

  pi.registerCommand('subagents', {
    description: 'Browse subagent runs and their logs',
    handler: async (_args, ctx) => {
      await openRunPicker(ctx);
    },
  });

  pi.registerShortcut('ctrl+shift+s', {
    description: 'Browse subagent runs',
    handler: async (ctx) => {
      await openRunPicker(ctx);
    },
  });

  const loadTimeAgents = (await discoverAgents(process.cwd(), 'user')).agents;
  const agentList =
    loadTimeAgents.map((a) => `"${a.name}" (${a.description})`).join(', ') ||
    'none';

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate tasks to specialized subagents with isolated context.',
      'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
      `Available agents: ${agentList}`,
      'Default agent scope is "user" (from ~/.pi/agent/agents).',
      'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
    ].join(' '),
    promptSnippet: `Delegate tasks to specialized subagents (${loadTimeAgents.map((a) => a.name).join(', ')})`,
    promptGuidelines: [
      `Use the "agent" parameter with an exact agent name. Available agents: ${loadTimeAgents.map((a) => `"${a.name}"`).join(', ')}`,
      'Do not invent agent names. Only use the exact names listed above.',
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope = (params.agentScope ?? 'user') as AgentScope;
      const discovery = await discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const parentModel = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      const parentThinkingLevel = ctx.model
        ? clampThinkingLevel(ctx.model, pi.getThinkingLevel())
        : pi.getThinkingLevel();
      const resolveModel = (model: string | undefined) => {
        if (!model) return undefined;
        const separator = model.indexOf('/');
        if (separator > 0) {
          return ctx.modelRegistry.find(
            model.slice(0, separator),
            model.slice(separator + 1),
          );
        }
        const matches = ctx.modelRegistry
          .getAll()
          .filter((candidate) => candidate.id === model);
        return matches.length === 1 ? matches[0] : undefined;
      };

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: 'single' | 'parallel' | 'chain') =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          packagedAgentsDir: discovery.packagedAgentsDir,
          results,
        });

      if (modeCount !== 1) {
        const available =
          agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
        return {
          content: [
            {
              type: 'text',
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails('single')([]),
        };
      }

      if (
        (agentScope === 'project' || agentScope === 'both') &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain)
          for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks)
          for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === 'project');

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(', ');
          const dir = discovery.projectAgentsDir ?? '(unknown)';
          const ok = await ctx.ui.confirm(
            'Run project-local agents?',
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [
                {
                  type: 'text',
                  text: 'Canceled: project-local agents not approved.',
                },
              ],
              details: makeDetails(
                hasChain ? 'chain' : hasTasks ? 'parallel' : 'single',
              )([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = '';

        for (const [i, step] of params.chain.entries()) {
          const taskWithContext = step.task.replace(
            /\{previous\}/g,
            previousOutput,
          );

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
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails('chain'),
            parentModel,
            parentThinkingLevel,
            resolveModel,
          );
          results.push(result);

          const isError =
            result.exitCode !== 0 ||
            result.stopReason === 'error' ||
            result.stopReason === 'aborted';
          if (isError) {
            const errorMsg =
              result.errorMessage ||
              result.stderr ||
              getFinalOutput(result.messages) ||
              '(no output)';
            return {
              content: [
                {
                  type: 'text',
                  text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
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
              text:
                getFinalOutput(results.at(-1)?.messages ?? []) || '(no output)',
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

        const allResults: SingleResult[] = new Array(params.tasks.length);

        for (const [i, task] of params.tasks.entries()) {
          allResults[i] = {
            agent: task.agent,
            agentSource: 'unknown',
            task: task.task,
            exitCode: -1,
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
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
              agents,
              t.agent,
              t.task,
              t.cwd,
              undefined,
              signal,
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails('parallel'),
              parentModel,
              parentThinkingLevel,
              resolveModel,
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          },
        );

        const successCount = results.filter((r) => r.exitCode === 0).length;
        const summaries = results.map((r) => {
          const output = getFinalOutput(r.messages);
          return `[${r.agent}] ${r.exitCode === 0 ? 'completed' : 'failed'}: ${output || '(no output)'}`;
        });
        return {
          content: [
            {
              type: 'text',
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n')}`,
            },
          ],
          details: makeDetails('parallel')(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails('single'),
          parentModel,
          parentThinkingLevel,
          resolveModel,
        );
        const isError =
          result.exitCode !== 0 ||
          result.stopReason === 'error' ||
          result.stopReason === 'aborted';
        if (isError) {
          const errorMsg =
            result.errorMessage ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            '(no output)';
          return {
            content: [
              {
                type: 'text',
                text: `Agent ${result.stopReason || 'failed'}: ${errorMsg}`,
              },
            ],
            details: makeDetails('single')([result]),
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: getFinalOutput(result.messages) || '(no output)',
            },
          ],
          details: makeDetails('single')([result]),
        };
      }

      const available =
        agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
      return {
        content: [
          {
            type: 'text',
            text: `Invalid parameters. Available agents: ${available}`,
          },
        ],
        details: makeDetails('single')([]),
      };
    },

    renderCall(args, theme, _context) {
      const scope = (args.agentScope ?? 'user') as AgentScope;
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg('toolTitle', theme.bold('subagent ')) +
          theme.fg('accent', `chain (${args.chain.length} steps)`) +
          theme.fg('muted', ` [${scope}]`);
        for (const [i, step] of args.chain.entries()) {
          const cleanTask = step.task.replace(/\{previous\}/g, '').trim();
          text +=
            '\n  ' +
            theme.fg('muted', `${i + 1}.`) +
            ' ' +
            theme.fg('accent', step.agent) +
            theme.fg('dim', ` ${cleanTask}`);
        }
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg('toolTitle', theme.bold('subagent ')) +
          theme.fg('accent', `parallel (${args.tasks.length} tasks)`) +
          theme.fg('muted', ` [${scope}]`);
        for (const t of args.tasks) {
          text += `\n  ${theme.fg('accent', t.agent)}${theme.fg('dim', ` ${t.task}`)}`;
        }
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || '...';
      const preview = args.task ? args.task : '...';
      let text =
        theme.fg('toolTitle', theme.bold('subagent ')) +
        theme.fg('accent', agentName) +
        theme.fg('muted', ` [${scope}]`);
      text += `\n  ${theme.fg('dim', preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(
          text?.type === 'text' ? text.text : '(no output)',
          0,
          0,
        );
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped =
          limit && items.length > limit ? items.length - limit : 0;
        let text = '';
        if (skipped > 0)
          text += theme.fg('muted', `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === 'text') {
            const preview = expanded
              ? item.text
              : item.text.split('\n').slice(0, 3).join('\n');
            text += `${theme.fg('toolOutput', preview)}\n`;
          } else {
            text += `${theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (details.mode === 'single' && details.results.length === 1) {
        const r = details.results[0]!;
        const isError =
          r.exitCode !== 0 ||
          r.stopReason === 'error' ||
          r.stopReason === 'aborted';
        const icon = isError
          ? theme.fg('error', '✗')
          : theme.fg('success', '✓');
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`;
          if (isError && r.stopReason)
            header += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(
              new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0),
            );
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0));
          container.addChild(new Text(theme.fg('dim', r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg('muted', '─── Output ───'), 0, 0),
          );
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(
              new Text(theme.fg('muted', '(no output)'), 0, 0),
            );
          } else {
            for (const item of displayItems) {
              if (item.type === 'toolCall')
                container.addChild(
                  new Text(
                    theme.fg('muted', '→ ') +
                      formatToolCall(
                        item.name,
                        item.args,
                        theme.fg.bind(theme),
                      ),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }
          }
          const usageStr = formatUsageStats(
            r.usage,
            r.model,
            r.thinkingLevel,
            r.contextWindow,
          );
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`;
        if (isError && r.stopReason)
          text += `\n${theme.fg('error', `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage)
          text += `\n${theme.fg('error', `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0)
          text += `\n${theme.fg('muted', '(no output)')}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          const hasClampedText = displayItems.some(
            (item) => item.type === 'text' && item.text.split('\n').length > 3,
          );
          if (displayItems.length > COLLAPSED_ITEM_COUNT || hasClampedText)
            text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
        }
        const usageStr = formatUsageStats(
          r.usage,
          r.model,
          r.thinkingLevel,
          r.contextWindow,
        );
        if (usageStr) text += `\n${theme.fg('dim', usageStr)}`;
        return new Text(text, 0, 0);
      }

      const aggregateUsage = (results: SingleResult[]) => {
        const total = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };

      if (details.mode === 'chain') {
        const successCount = details.results.filter(
          (r) => r.exitCode === 0,
        ).length;
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
                theme.fg(
                  'accent',
                  `${successCount}/${details.results.length} steps`,
                ),
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon =
              r.exitCode === 0
                ? theme.fg('success', '✓')
                : theme.fg('error', '✗');
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg('muted', `─── Step ${r.step}: `) + theme.fg('accent', r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(
                theme.fg('muted', 'Task: ') + theme.fg('dim', r.task),
                0,
                0,
              ),
            );

            for (const item of displayItems) {
              if (item.type === 'toolCall') {
                container.addChild(
                  new Text(
                    theme.fg('muted', '→ ') +
                      formatToolCall(
                        item.name,
                        item.args,
                        theme.fg.bind(theme),
                      ),
                    0,
                    0,
                  ),
                );
              }
            }

            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }

            const stepUsage = formatUsageStats(
              r.usage,
              r.model,
              r.thinkingLevel,
              r.contextWindow,
            );
            if (stepUsage)
              container.addChild(new Text(theme.fg('dim', stepUsage), 0, 0));
          }

          const usageStr = formatUsageStats(
            aggregateUsage(details.results),
            details.results[0]?.model,
            details.results[0]?.thinkingLevel,
          );
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0),
            );
          }
          return container;
        }

        let text =
          icon +
          ' ' +
          theme.fg('toolTitle', theme.bold('chain ')) +
          theme.fg('accent', `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const rIcon =
            r.exitCode === 0
              ? theme.fg('success', '✓')
              : theme.fg('error', '✗');
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg('muted', `─── Step ${r.step}: `)}${theme.fg('accent', r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg('muted', '(no output)')}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(
          aggregateUsage(details.results),
          details.results[0]?.model,
          details.results[0]?.thinkingLevel,
        );
        if (usageStr) text += `\n\n${theme.fg('dim', `Total: ${usageStr}`)}`;
        text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === 'parallel') {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter(
          (r) => r.exitCode === 0,
        ).length;
        const failCount = details.results.filter((r) => r.exitCode > 0).length;
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
            const rIcon =
              r.exitCode === 0
                ? theme.fg('success', '✓')
                : theme.fg('error', '✗');
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg('muted', '─── ') + theme.fg('accent', r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(
                theme.fg('muted', 'Task: ') + theme.fg('dim', r.task),
                0,
                0,
              ),
            );

            for (const item of displayItems) {
              if (item.type === 'toolCall') {
                container.addChild(
                  new Text(
                    theme.fg('muted', '→ ') +
                      formatToolCall(
                        item.name,
                        item.args,
                        theme.fg.bind(theme),
                      ),
                    0,
                    0,
                  ),
                );
              }
            }

            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }

            const taskUsage = formatUsageStats(
              r.usage,
              r.model,
              r.thinkingLevel,
              r.contextWindow,
            );
            if (taskUsage)
              container.addChild(new Text(theme.fg('dim', taskUsage), 0, 0));
          }

          const usageStr = formatUsageStats(
            aggregateUsage(details.results),
            details.results[0]?.model,
            details.results[0]?.thinkingLevel,
          );
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0),
            );
          }
          return container;
        }

        let text = `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`;
        for (const r of details.results) {
          const rIcon =
            r.exitCode === -1
              ? theme.fg('warning', '⏳')
              : r.exitCode === 0
                ? theme.fg('success', '✓')
                : theme.fg('error', '✗');
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg('muted', '─── ')}${theme.fg('accent', r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg('muted', r.exitCode === -1 ? '(running...)' : '(no output)')}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
          const usageStr = formatUsageStats(
            aggregateUsage(details.results),
            details.results[0]?.model,
            details.results[0]?.thinkingLevel,
          );
          if (usageStr) text += `\n\n${theme.fg('dim', `Total: ${usageStr}`)}`;
        }
        if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
    },
  });
}

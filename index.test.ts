import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './index.ts';

type Tool = {
  parameters: { properties: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: { content: { text: string }[] }) => void) | undefined,
    ctx: unknown,
  ) => Promise<{
    content: { type: string; text: string }[];
    details?: unknown;
    isError?: boolean;
  }>;
  renderResult: (
    result: unknown,
    options: { expanded: boolean },
    theme: unknown,
  ) => { render: (width: number) => string[] };
};

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-test-'));
const argsFile = path.join(binDir, 'args.jsonl');
const pidFile = path.join(binDir, 'pid');
const envFile = path.join(binDir, 'env.jsonl');
fs.writeFileSync(
  path.join(binDir, 'pi'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[args.length - 1].includes('ignore-term')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
fs.appendFileSync(
  ${JSON.stringify(envFile)},
  JSON.stringify({
    depth: process.env.PI_SUBAGENT_DEPTH,
    maxDepth: process.env.PI_SUBAGENT_MAX_DEPTH,
  }) + '\\n',
);
if (args[args.length - 1].includes('hang')) {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
}
const task = args[args.length - 1];
if (task.includes('crash')) process.kill(process.pid, 'SIGKILL');
const message = {
  role: 'assistant',
  content: [{ type: 'text', text: task.includes('big-emoji') ? 'a' + '😀'.repeat(20000) : 'done: ' + task }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  stopReason: 'stop',
};
const line = Buffer.from(JSON.stringify({ type: 'message_end', message }) + '\\n');
if (task.includes('split-utf8')) {
  const cut = line.indexOf(Buffer.from('é')) + 1;
  process.stdout.write(line.subarray(0, cut), () => {
    setTimeout(() => process.stdout.write(line.subarray(cut)), 50);
  });
} else {
  process.stdout.write(line);
}
if (task.includes('exit-fail')) process.exitCode = 1;
`,
  { mode: 0o755 },
);
process.env['PATH'] = `${binDir}${path.delimiter}${process.env['PATH']}`;
process.argv[1] = path.join(binDir, 'missing');

const ctx = {
  cwd: binDir,
  hasUI: false,
  model: { provider: 'anthropic', id: 'claude-opus-5-5', contextWindow: 200000 },
  thinkingLevel: 'medium',
  isProjectTrusted: () => true,
};

type SentMessage = {
  message: { customType: string; content: string; display: boolean };
  options: unknown;
};

function loadExtension(settings: Record<string, unknown> = {}) {
  let tool: Tool | undefined;
  const sent: SentMessage[] = [];
  const handlers: Record<string, (() => unknown)[]> = {};
  const pi = {
    registerTool: (t: Tool) => {
      tool = t;
    },
    sendMessage: (message: SentMessage['message'], options: unknown) => {
      sent.push({ message, options });
    },
    on: (event: string, handler: () => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    getSettings: () => settings,
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.ok(tool);
  return { tool, sent, handlers };
}

function getTool(): Tool {
  return loadExtension().tool;
}

function registersTool(): boolean {
  let registered = false;
  const pi = {
    registerTool: () => {
      registered = true;
    },
    on: () => {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return registered;
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function childEnvs(): { depth?: string; maxDepth?: string }[] {
  return fs
    .readFileSync(envFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function waitFor(check: () => boolean) {
  while (!check()) await new Promise((r) => setTimeout(r, 20));
}

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

function renderResults(mode: string, results: Record<string, unknown>[]): string[] {
  const details = {
    mode,
    results: results.map((result) => ({
      label: 'step 1',
      task: 't',
      step: 1,
      stderr: '',
      usage: emptyUsage,
      ...result,
    })),
  };
  return getTool()
    .renderResult({ content: [], details }, { expanded: false }, plainTheme)
    .render(200)
    .map((line) => line.trimEnd());
}

function renderResult(mode: string, result: Record<string, unknown>): string {
  return renderResults(mode, [result]).join('\n');
}

const usedUsage = { ...emptyUsage, input: 1200, output: 300, turns: 2 };

function messagesWith(...paths: string[]) {
  const toolCalls = paths.map((p) => ({ type: 'toolCall', name: 'read', arguments: { path: p } }));
  return [{ role: 'assistant', content: [{ type: 'text', text: 'line 1\nline 2' }, ...toolCalls] }];
}

function childArgs(): string[][] {
  return fs
    .readFileSync(argsFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
}

const inherited = ['--provider', 'anthropic', '--model', 'claude-opus-5-5', '--thinking', 'medium'];

function assertInherits(args: string[]) {
  const start = args.indexOf('--provider');
  assert.deepEqual(args.slice(start, start + inherited.length), inherited);
  assert.ok(!args.includes('--append-system-prompt'));
  assert.ok(!args.includes('--tools'));
}

beforeEach(() => {
  fs.rmSync(argsFile, { force: true });
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(envFile, { force: true });
});

test('passes the parent provider, model and thinking level to a single subagent', async () => {
  const result = await getTool().execute('1', { task: 'find bugs' }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0]?.text, 'done: Task: find bugs');
  const calls = childArgs();
  assert.equal(calls.length, 1);
  assertInherits(calls[0]!);
});

test('passes the parent provider, model and thinking level to parallel subagents', async () => {
  const result = await getTool().execute(
    '1',
    { tasks: [{ task: 'one' }, { task: 'two' }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0]?.text ?? '', /^Parallel: 2\/2 succeeded/);
  const calls = childArgs();
  assert.equal(calls.length, 2);
  for (const args of calls) assertInherits(args);
});

test('passes the parent provider, model and thinking level to chained subagents', async () => {
  const result = await getTool().execute(
    '1',
    { chain: [{ task: 'one' }, { task: 'after {previous}' }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.content[0]?.text, 'done: Task: after done: Task: one');
  const calls = childArgs();
  assert.equal(calls.length, 2);
  for (const args of calls) assertInherits(args);
});

test('inserts previous output literally in chained tasks', async () => {
  const result = await getTool().execute(
    '1',
    { chain: [{ task: "costs $& and $'" }, { task: 'after {previous}' }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.content[0]?.text, "done: Task: after done: Task: costs $& and $'");
});

test('keeps multi-byte characters split across output chunks', async () => {
  const result = await getTool().execute(
    '1',
    { task: 'split-utf8 café' },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.content[0]?.text, 'done: Task: split-utf8 café');
});

test('reports a subagent killed by a signal as failed', async () => {
  const result = await getTool().execute('1', { task: 'crash' }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
});

test('reports why a subagent could not start', async () => {
  const result = await getTool().execute(
    '1',
    { task: 'one', cwd: path.join(binDir, 'missing-dir') },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /ENOENT/);
});

test('labels a failed parallel task without its normal stop reason', async () => {
  const result = await getTool().execute(
    '1',
    { tasks: [{ task: 'exit-fail' }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0]?.text ?? '', /### \[task 1\] failed\n/);
});

test('truncates long parallel output without splitting characters', async () => {
  const result = await getTool().execute(
    '1',
    { tasks: [{ task: 'big-emoji' }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0]?.text ?? '', /\] completed\n\na😀+\n\n\[Output truncated/u);
});

test('reports a parallel task as running until its process exits', async () => {
  const updates: string[] = [];
  await getTool().execute(
    '1',
    { tasks: [{ task: 'one' }] },
    undefined,
    (partial) => updates.push(partial.content[0]!.text),
    ctx,
  );
  assert.equal(updates[0], 'Parallel: 0/1 done, 1 running...');
});

test('shows a chain step that stopped with an error as failed', () => {
  const text = renderResult('chain', { exitCode: 0, stopReason: 'error', messages: [] });
  assert.match(text, /✗ chain 0\/1 steps/);
});

test('renders a tool call whose path is not a string', () => {
  const toolCall = { type: 'toolCall', name: 'read', arguments: { path: 42 } };
  const messages = [{ role: 'assistant', content: [toolCall] }];
  assert.match(renderResult('single', { exitCode: 0, messages }), /read 42/);
});

test('collapses a single subagent to one line with its last tool call and usage', () => {
  const lines = renderResults('single', [
    { label: 'subagent', exitCode: 0, usage: usedUsage, messages: messagesWith('a.ts', 'b.ts') },
  ]);
  assert.deepEqual(lines, ['✓ subagent → read b.ts · 2 turns ↑1.2k ↓300']);
});

test('collapses parallel tasks to a header and one line per task', () => {
  const lines = renderResults('parallel', [
    { label: 'task 1', exitCode: 0, usage: usedUsage, messages: messagesWith('a.ts') },
    { label: 'task 2', exitCode: -1, usage: emptyUsage, messages: [] },
  ]);
  assert.deepEqual(lines, [
    '⏳ parallel 1/2 done, 1 running',
    '  ✓ task 1 → read a.ts · 2 turns ↑1.2k ↓300',
    '  ⏳ task 2',
  ]);
});

test('collapses chain steps to a header with totals and one line per step', () => {
  const lines = renderResults('chain', [
    { label: 'step 1', exitCode: 0, usage: usedUsage, messages: messagesWith('a.ts') },
    { label: 'step 2', exitCode: 0, usage: usedUsage, messages: messagesWith('b.ts') },
  ]);
  assert.deepEqual(lines, [
    '✓ chain 2/2 steps · Total: 4 turns ↑2.4k ↓600',
    '  ✓ step 1 → read a.ts · 2 turns ↑1.2k ↓300',
    '  ✓ step 2 → read b.ts · 2 turns ↑1.2k ↓300',
  ]);
});

test('shows the first line of the error on a failed collapsed subagent', () => {
  const lines = renderResults('single', [
    {
      label: 'subagent',
      exitCode: 1,
      stopReason: 'error',
      errorMessage: 'boom\nstack',
      messages: messagesWith('a.ts'),
    },
  ]);
  assert.deepEqual(lines, ['✗ subagent [error] boom']);
});

test('shows context percentage and short model name without cost', () => {
  const lines = renderResults('single', [
    {
      label: 'subagent',
      exitCode: 0,
      usage: { ...usedUsage, cost: 0.5, contextTokens: 24000 },
      contextWindow: 200000,
      model: 'anthropic/claude-opus-5-5',
      messages: messagesWith('a.ts'),
    },
  ]);
  assert.deepEqual(lines, ['✓ subagent → read a.ts · 2 turns ↑1.2k ↓300 12%/200k opus-5-5']);
});

test('renders the parent context window for a finished subagent', async () => {
  const tool = getTool();
  const result = await tool.execute('1', { task: 'find bugs' }, undefined, undefined, ctx);
  const lines = tool
    .renderResult(result, { expanded: false }, plainTheme)
    .render(200)
    .map((line) => line.trimEnd());
  assert.deepEqual(lines, ['✓ subagent · 1 turn ↑1 ↓1 0%/200k opus-5-5']);
});

test('kills a subagent that ignores SIGTERM after abort', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const run = getTool().execute('1', { task: 'ignore-term' }, controller.signal, undefined, ctx);
  while (!fs.existsSync(argsFile)) await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await assert.rejects(run, /aborted/);
});

test('does not offer agent selection', () => {
  const properties = Object.keys(getTool().parameters.properties);
  assert.deepEqual(properties.sort(), ['background', 'chain', 'cwd', 'task', 'tasks']);
});

test('returns at once from a background subagent and delivers its result as a follow-up', async () => {
  const { tool, sent } = loadExtension();
  const result = await tool.execute(
    '1',
    { task: 'find bugs', background: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0]?.text ?? '', /^Started background subagent job 1\./);
  assert.equal(sent.length, 0);
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(sent[0]!.message.customType, 'subagent-result');
  assert.equal(sent[0]!.message.display, true);
  assert.equal(
    sent[0]!.message.content,
    'Background subagent job 1 finished:\n\ndone: Task: find bugs',
  );
});

test('delivers a failed background subagent as failed', async () => {
  const { tool, sent } = loadExtension();
  await tool.execute('1', { task: 'crash', background: true }, undefined, undefined, ctx);
  await waitFor(() => sent.length === 1);
  assert.match(sent[0]!.message.content, /^Background subagent job 1 failed:\n\nAgent failed/);
});

test('runs parallel tasks in the background', async () => {
  const { tool, sent } = loadExtension();
  await tool.execute(
    '1',
    { tasks: [{ task: 'one' }, { task: 'two' }], background: true },
    undefined,
    undefined,
    ctx,
  );
  await waitFor(() => sent.length === 1);
  assert.match(sent[0]!.message.content, /finished:\n\nParallel: 2\/2 succeeded/);
});

test('keeps a background subagent running when the tool call is aborted', async () => {
  const { tool, sent } = loadExtension();
  const controller = new AbortController();
  await tool.execute('1', { task: 'one', background: true }, controller.signal, undefined, ctx);
  controller.abort();
  await waitFor(() => sent.length === 1);
  assert.match(sent[0]!.message.content, /finished:\n\ndone: Task: one$/);
});

test('shows running background subagents in the status line', async () => {
  const { tool, sent } = loadExtension();
  const statuses: (string | undefined)[] = [];
  const uiCtx = {
    ...ctx,
    hasUI: true,
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  await tool.execute('1', { task: 'one', background: true }, undefined, undefined, uiCtx);
  await tool.execute('2', { task: 'two', background: true }, undefined, undefined, uiCtx);
  await waitFor(() => sent.length === 2);
  assert.deepEqual(statuses, ['1 subagent', '2 subagents', '1 subagent', undefined]);
});

test('stops background subagents when the session shuts down', async () => {
  const { tool, sent, handlers } = loadExtension();
  await tool.execute('1', { task: 'hang', background: true }, undefined, undefined, ctx);
  await waitFor(() => fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (const handler of handlers['session_shutdown'] ?? []) await handler();
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
});

test('passes depth 1 and the default max depth of 2 to a subagent', async () => {
  await loadExtension().tool.execute('1', { task: 'one' }, undefined, undefined, ctx);
  assert.deepEqual(childEnvs(), [{ depth: '1', maxDepth: '2' }]);
});

test('reads the max depth from subagent.maxDepth in settings', async () => {
  const { tool } = loadExtension({ subagent: { maxDepth: 3 } });
  await tool.execute('1', { task: 'one' }, undefined, undefined, ctx);
  assert.deepEqual(childEnvs(), [{ depth: '1', maxDepth: '3' }]);
});

test('passes the inherited max depth on to nested subagents', async () => {
  const { tool } = withEnv({ PI_SUBAGENT_DEPTH: '1', PI_SUBAGENT_MAX_DEPTH: '3' }, () =>
    loadExtension({ subagent: { maxDepth: 5 } }),
  );
  await tool.execute('1', { task: 'one' }, undefined, undefined, ctx);
  assert.deepEqual(childEnvs(), [{ depth: '2', maxDepth: '3' }]);
});

test('does not offer the subagent tool at the max depth', () => {
  assert.equal(
    withEnv({ PI_SUBAGENT_DEPTH: '1', PI_SUBAGENT_MAX_DEPTH: '2' }, registersTool),
    true,
  );
  assert.equal(
    withEnv({ PI_SUBAGENT_DEPTH: '2', PI_SUBAGENT_MAX_DEPTH: '2' }, registersTool),
    false,
  );
});

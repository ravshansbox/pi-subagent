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
    onUpdate: undefined,
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

function getTool(): Tool {
  let tool: Tool | undefined;
  const pi = {
    registerTool: (t: Tool) => {
      tool = t;
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.ok(tool);
  return tool;
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
  assert.deepEqual(properties.sort(), ['chain', 'cwd', 'task', 'tasks']);
});

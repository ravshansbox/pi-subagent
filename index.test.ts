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
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
};

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-test-'));
const argsFile = path.join(binDir, 'args.jsonl');
fs.writeFileSync(
  path.join(binDir, 'pi'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
const task = args[args.length - 1];
const message = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done: ' + task }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  stopReason: 'stop',
};
console.log(JSON.stringify({ type: 'message_end', message }));
`,
  { mode: 0o755 },
);
process.env['PATH'] = `${binDir}${path.delimiter}${process.env['PATH']}`;
process.argv[1] = path.join(binDir, 'missing');

const ctx = {
  cwd: binDir,
  hasUI: false,
  model: { provider: 'anthropic', id: 'claude-opus-5-5' },
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

test('does not offer agent selection', () => {
  const properties = Object.keys(getTool().parameters.properties);
  assert.deepEqual(properties.sort(), ['chain', 'cwd', 'task', 'tasks']);
});

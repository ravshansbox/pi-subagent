import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = ['./index.ts', './agents.ts'];
const sources = await Promise.all(files.map(async file => [file, await readFile(new URL(file, import.meta.url), 'utf8')]));

test('subagent extension avoids synchronous filesystem APIs', () => {
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /\b(existsSync|readdirSync|readFileSync|statSync|unlinkSync|rmdirSync)\b/, file);
  }
});

# pi-subagent

Subagent extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-subagent
```

Add `-l` to install it in project settings.

## Usage

Pi loads the extension from `./index.ts`, adapted from pi's `examples/extensions/subagent`:

- `subagent` tool for the model, with three modes:
  - single: `{ task }`
  - parallel: `{ tasks: [...] }`, up to 8 tasks, 4 at a time
  - chain: `{ chain: [...] }`, where `{previous}` is replaced with the previous step's output

Each subagent runs in a separate `pi` process with its own context window. It uses the parent session's current provider, model and thinking level, passed as `--provider`, `--model` and `--thinking`.

The collapsed result shows one line per subagent, with its last tool call and usage, or the first line of its error. Press Ctrl+O to expand it.

Add `background: true` to any mode to return at once. The result arrives later as a follow-up message, which starts a new turn once the agent is idle. The status line shows how many background subagents are running. Esc does not stop them, but they are stopped when the session shuts down.

## Development

```bash
npm install
npm run check
```

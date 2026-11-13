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

Output returned to the model is limited to 50 KB per subagent, and so is `{previous}`. The model can raise this with `maxOutputBytes`, up to 1 MB. The full output stays in the tool details.

Each subagent runs in a separate `pi` process with its own context window. It uses the parent session's current provider, model and thinking level, passed as `--provider`, `--model` and `--thinking`.

The collapsed result shows one line per subagent, with its status (`running`, `done` or `failed`) and usage, or the first line of its error. Press Ctrl+O to expand it.

Add `background: true` to any mode to return at once. The result arrives later as a follow-up message, which starts a new turn once the agent is idle. Up to 5 background jobs can run at once. The status line shows how many background subagents are running. Esc does not stop them, but they are stopped when the session shuts down.

Subagents can start their own subagents, up to a maximum depth. The default is 2, which allows main → subagent → subagent. Subagents at the maximum depth do not get the `subagent` tool. To change it, set `subagent.maxDepth` in `settings.json`:

```json
{
  "subagent": { "maxDepth": 3 }
}
```

The main session reads this setting and passes it down to all nested subagents.

Nested subagents cannot use `background`. A subagent's process exits when its turn ends, which would stop the job, and a late follow-up would replace its final reply.

## Development

```bash
npm install
npm run check
```

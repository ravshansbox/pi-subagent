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
  - single: `{ agent, task }`
  - parallel: `{ tasks: [...] }`, up to 8 tasks, 4 at a time
  - chain: `{ chain: [...] }`, where `{previous}` is replaced with the previous step's output

Each subagent runs in a separate `pi` process with its own context window.

When an agent omits `model`, the subagent inherits the parent session's current model and thinking level.

## Agents

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
---

System prompt for the agent goes here.
```

Pi looks for agents in:

- `~/.pi/agent/agents/*.md`, always
- `.pi/agents/*.md`, only with `agentScope: "project"` or `"both"`

Project agents override user agents with the same name. Pi asks before running project agents in untrusted projects.

The sample agents in [`agents/`](agents) and workflow prompts in [`prompts/`](prompts) are not installed with the package. Copy them to `~/.pi/agent/agents/` and `~/.pi/agent/prompts/` to use them.

## Development

```bash
npm install
npm run check
```

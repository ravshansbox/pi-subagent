# pi-subagent

Subagent extension for pi — delegate tasks to isolated subagent processes.

## Contents

- `src/index.ts` - subagent tool implementation
- `src/agents.ts` - agent discovery logic
- `agents/` - bundled agent definitions (ships with `general`)

## Bundled agent

| Agent | Description |
|-------|-------------|
| `general` | Default general-purpose subagent with full capabilities |

Add your own agents to `~/.pi/agent/agents/` or `.pi/agents/`. See below.

## Requirements

This package is meant to be used from an existing pi installation.
It relies on pi packages already available in the runtime environment:

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@sinclair/typebox`

## Installation

```bash
pi install git:git@github.com:ravshansbox/pi-subagent.git
```

Bundled agents are loaded directly from the package — no extra setup needed.

You can also pin to a ref:

```bash
pi install git:git@github.com:ravshansbox/pi-subagent.git@main
```

### Project-local install

```bash
pi install -l git:git@github.com:ravshansbox/pi-subagent.git
```

### Manual install

Clone and symlink if you prefer local development:

```bash
git clone git@github.com:ravshansbox/pi-subagent.git ~/Projects/pi-subagent
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf ~/Projects/pi-subagent/src/index.ts ~/.pi/agent/extensions/subagent/index.ts
ln -sf ~/Projects/pi-subagent/src/agents.ts ~/.pi/agent/extensions/subagent/agents.ts
```

## Verify

After install and reload, verify:

- the `subagent` tool is available
- the `general` agent is discoverable

Smoke test: ask pi to use the `subagent` tool with the `general` agent.

## Upgrade

```bash
pi update git:git@github.com:ravshansbox/pi-subagent.git
```

## Adding custom agents

Create markdown files with YAML frontmatter in `~/.pi/agent/agents/` or `.pi/agents/`:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

Custom agents override bundled agents with the same name.

## Agent precedence

1. packaged default agents from this package
2. user agents from `~/.pi/agent/agents`
3. project agents from `.pi/agents`

Later sources override earlier ones by name.



## Notes

This package currently keeps pi dependencies as peer dependencies and is intended as a local reusable package.

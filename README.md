# @ravshansbox/pi-subagent

Subagent extension for pi — delegate tasks to isolated subagent processes.

## Contents

- `index.ts` - subagent tool implementation
- `agents.ts` - agent discovery logic
- `agents/` - bundled agent definitions (ships with `delegate`)

## Bundled agent

| Agent      | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `delegate` | Default general-purpose subagent for delegated tasks with full capabilities |

Add your own agents to `~/.pi/agent/agents/` or `.pi/agents/`. See below.

## Requirements

This package is meant to be used from an existing pi installation.
It relies on pi packages already available in the runtime environment:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

## Installation

```bash
pi install npm:@ravshansbox/pi-subagent
```

Bundled agents are loaded directly from the package — no extra setup needed.

### Project-local install

```bash
pi install -l npm:@ravshansbox/pi-subagent
```

### Install from Git

```bash
pi install git:git@github.com:ravshansbox/pi-subagent.git
```

You can also pin to a ref:

```bash
pi install git:git@github.com:ravshansbox/pi-subagent.git@main
```

### Manual install

Clone and symlink if you prefer local development:

```bash
git clone git@github.com:ravshansbox/pi-subagent.git ~/Projects/pi-subagent
mkdir -p ~/.pi/agent/extensions/subagent ~/.pi/agent/extensions/subagent/agents
ln -sf ~/Projects/pi-subagent/index.ts ~/.pi/agent/extensions/subagent/index.ts
ln -sf ~/Projects/pi-subagent/agents.ts ~/.pi/agent/extensions/subagent/agents.ts
ln -sf ~/Projects/pi-subagent/agents/delegate.md ~/.pi/agent/extensions/subagent/agents/delegate.md
```

## Verify

After install and reload, verify:

- the `subagent` tool is available
- the `delegate` agent is discoverable

Smoke test: ask pi to use the `subagent` tool with the `delegate` agent.

## Upgrade

```bash
pi update npm:@ravshansbox/pi-subagent
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

## Publishing

Releases after `0.1.0` are published by `.github/workflows/publish.yml` using npm Trusted Publishing and the `npm-publish` GitHub environment. Protect this environment with required reviewers in the repository settings. The workflow requires a GitHub Release tag matching `v<package version>` and publishes with automatic provenance.

Because npm requires a package to exist before assigning a trusted publisher, bootstrap `0.1.0` once from an authenticated local npm CLI:

```bash
npm login
npm publish
```

Then configure the `@ravshansbox/pi-subagent` trusted publisher on npmjs.com:

- provider: GitHub Actions
- organisation or user: `ravshansbox`
- repository: `pi-subagent`
- workflow: `publish.yml`
- environment: `npm-publish`

No `NPM_TOKEN` is required after the trusted publisher is configured.

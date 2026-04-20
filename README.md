# pi-subagent

Extracted `subagent` extension for pi, packaged with sample agents and workflow prompts.

## Contents

- `src/index.ts` - subagent tool implementation
- `src/agents.ts` - agent discovery logic
- `agents/` - sample agent definitions
- `prompts/` - sample workflow prompts

## Requirements

This package is meant to be used from an existing pi installation.
It relies on pi packages already available in the runtime environment:

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@sinclair/typebox`

## Installation

Recommended install via pi package manager:

```bash
pi install git:git@github.com:ravshansbox/pi-subagent.git
```

This installs the package as a git-based pi package and lets pi discover its resources automatically.

You can also pin to a ref if needed:

```bash
pi install git:git@github.com:ravshansbox/pi-subagent.git@main
```

### Project-local install

To install only for the current project:

```bash
pi install -l git:git@github.com:ravshansbox/pi-subagent.git
```

### Manual install

If you prefer local development with symlinks instead of `pi install`, clone the repository somewhere on your machine, for example:

```bash
git clone git@github.com:ravshansbox/pi-subagent.git ~/Projects/pi-subagent
```

Then symlink the extension code:

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf ~/Projects/pi-subagent/src/index.ts ~/.pi/agent/extensions/subagent/index.ts
ln -sf ~/Projects/pi-subagent/src/agents.ts ~/.pi/agent/extensions/subagent/agents.ts
```

Symlink sample agents:

```bash
mkdir -p ~/.pi/agent/agents
for f in ~/Projects/pi-subagent/agents/*.md; do
  ln -sf "$f" ~/.pi/agent/agents/$(basename "$f")
done
```

Symlink workflow prompts:

```bash
mkdir -p ~/.pi/agent/prompts
for f in ~/Projects/pi-subagent/prompts/*.md; do
  ln -sf "$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

### Restart pi

Restart pi so it reloads extensions, agents, and prompts.

## Verify installation

After restart, verify:

- the `subagent` tool is available
- sample agents like `scout`, `planner`, `worker`, and `reviewer` are discoverable
- workflow prompts like `/implement` and `/scout-and-plan` are available

A simple smoke test is to ask pi to use the `subagent` tool with the `scout` agent on any small codebase task.

## Upgrade

Because the install uses symlinks, updating the cloned repository updates what pi sees immediately. After pulling changes, restart pi if needed.

```bash
cd ~/Projects/pi-subagent
git pull
```

## Optional cleanup

If you previously had a standalone copy under `~/.pi/agent/extensions/subagent`, you can remove duplicate bundled files there after confirming the symlinks work.

## Notes

This package currently keeps pi dependencies as peer dependencies and is intended as a local reusable package.

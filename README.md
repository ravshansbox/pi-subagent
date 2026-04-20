# pi-subagent

Extracted `subagent` extension for pi, packaged with sample agents and workflow prompts.

## Contents

- `src/index.ts` - subagent tool implementation
- `src/agents.ts` - agent discovery logic
- `agents/` - sample agent definitions
- `prompts/` - sample workflow prompts

## Install into pi

Symlink the extension code:

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

## Notes

This package currently keeps pi dependencies as peer dependencies and is intended as a local reusable package.

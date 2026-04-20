---
description: General gathers context and creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "general" agent to find all code relevant to: $@
2. Then, use the "general" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan.

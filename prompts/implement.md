---
description: Full implementation workflow - scout gathers context, planner creates plan, general implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "general" agent to find all code relevant to: $@
2. Then, use the "general" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "general" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.

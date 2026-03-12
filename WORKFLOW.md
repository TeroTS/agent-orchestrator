---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: project_slug_here
  dispatch_state: In Progress
  handoff_state: In Review
  active_states:
    - Todo
    - In Progress
    - Rework
  terminal_states:
    - Done
polling:
  interval_ms: 5000
workspace:
  root: ./.symphony/workspaces
hooks:
  after_create: |
    git clone --quiet --no-local "$(git -C ../../.. rev-parse --show-toplevel)" .
  before_run: |
    if [ -d ../../../node_modules ] && [ ! -e node_modules ]; then
      ln -s ../../../node_modules node_modules
    fi
  timeout_ms: 60000
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 300000
  stall_timeout_ms: 120000
  turn_sandbox_policy:
    type: workspaceWrite
---

You are working on Linear ticket `{{ issue.identifier }}` in the repository copy provided for this run.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of starting over.
- Avoid repeating completed investigation or validation unless new changes require it.
  {% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Execution rules:

1. Work only inside the provided workspace for this issue.
2. Operate autonomously and complete the task end to end unless blocked by missing auth, permissions, or required external systems.
3. Reproduce the issue or confirm the requested change before implementing when practical.
4. Prefer targeted validation that proves the changed behavior directly.
5. If Linear access is available through MCP or the injected `linear_graphql` tool, use it when the task requires tracker context.
6. When the implementation work is complete and validation passes, move the issue to `In Review` using `linear_graphql` unless a different handoff state is clearly required.
7. Final output must summarize completed work, validation run, and any remaining blocker.

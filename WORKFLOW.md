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
Issue ID: {{ issue.id }}
Branch Name: {{ issue.branchName }}
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
5. Do not commit directly to `main`.
6. Work on an issue branch. If `Branch Name` is present, use it. Otherwise create a deterministic branch from the issue identifier and title, and reuse the same branch on later `Rework` runs.
7. After the implementation work and validation are complete, push the branch and open or update a GitHub pull request before posting your final Linear completion comment.
8. If Linear access is available, use `linear_graphql` only when the task needs tracker context or other Linear operations that are not covered by a dedicated tool.
9. Linear lookup rules:
   - The current Linear issue id is already provided in this prompt as `Issue ID`. Use that provided id for `linear_add_issue_comment`.
   - Do not use `linear_graphql` just to look up the current issue id for the completion comment.
   - To fetch a Linear issue by ticket identifier such as `OWN-15`, query the `issues` connection with an identifier filter, for example:
     `query IssueByIdentifier($identifier: String!) { issues(filter: { identifier: { eq: $identifier } }) { nodes { id identifier title } } }`
   - Use the returned issue `id` for follow-up operations.
   - Do not use `issueV2(...)`.
   - Do not use `issue(identifier: ...)`.
   - `issue(id: ...)` is only for a known Linear issue id / UUID, not for identifier-based lookup.
10. When the implementation work is complete and validation passes, call `linear_add_issue_comment` exactly once with the provided `Issue ID` and a 2-4 sentence plain-text summary of what changed and how you validated it.
11. Include the GitHub pull request URL in that `linear_add_issue_comment` body.
12. Do not use `linear_graphql` to post the completion comment unless `linear_add_issue_comment` is unavailable or clearly failing.
13. Post the Linear completion comment before your final output.
14. Final output must summarize completed work, validation run, and any remaining blocker.

---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: testing-symphony-da507e24c326
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
    set -eu
    repo_root="$(git -C ../../.. rev-parse --show-toplevel)"
    git clone --quiet --no-local "$repo_root" .
    fetch_url="$(git -C "$repo_root" remote get-url origin)"
    push_url="$(git -C "$repo_root" remote get-url --push origin 2>/dev/null || true)"
    if [ -z "$fetch_url" ]; then
      echo "Source repository must have an origin remote." >&2
      exit 1
    fi
    git remote set-url origin "$fetch_url"
    if [ -n "$push_url" ]; then
      git remote set-url --push origin "$push_url"
    fi
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

Ticket context:
Ticket ID: {{ issue.id }}
Branch Name: {{ issue.branchName }}
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current ticket status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Recent ticket comments:
{% if issue.comments.size > 0 %}
{% for comment in issue.comments %}

- {% if comment.createdAt %}[{{ comment.createdAt }}] {% endif %}{% if comment.authorName %}{{ comment.authorName }}{% else %}Unknown author{% endif %}: {{ comment.body }}{% if comment.url %} ({{ comment.url }}){% endif %}
  {% endfor %}
  {% else %}
  No recent comments.
  {% endif %}

Latest GitHub review feedback:
{% if issue.githubReviewComments.size > 0 or issue.githubReviewSummary %}
{% if issue.githubReviewRound %}- Review round: {{ issue.githubReviewRound }}{% if issue.githubReviewUrl %} ({{ issue.githubReviewUrl }}){% endif %}
{% elseif issue.githubReviewUrl %}- Review URL: {{ issue.githubReviewUrl }}
{% endif %}
{% if issue.githubReviewSummary %}

- Summary: {{ issue.githubReviewSummary }}
  {% endif %}
  {% for comment in issue.githubReviewComments %}
- {% if comment.createdAt %}[{{ comment.createdAt }}] {% endif %}{% if comment.authorName %}{{ comment.authorName }}{% else %}Unknown author{% endif %}: {{ comment.body }}{% if comment.url %} ({{ comment.url }}){% endif %}
  {% endfor %}
  {% else %}
  No recent GitHub review feedback.
  {% endif %}

Execution rules:

1. Work only inside the provided workspace for this ticket.
2. Operate autonomously and complete the task end to end unless blocked by missing auth, permissions, or required external systems.
3. Reproduce the ticket or confirm the requested change before implementing when practical.
4. Prefer targeted validation that proves the changed behavior directly.
5. Do not commit directly to `main`.
6. Work on a ticket branch. If `Branch Name` is present, use it. Otherwise create a deterministic branch from the ticket identifier and title, and reuse the same branch on later `Rework` runs.
7. After the implementation work and validation are complete, publish the ticket branch and open or update a GitHub pull request before posting your final Linear completion comment.
8. Use the repository's standard push/publish workflow from the local `push` skill for the exact GitHub CLI procedure.
9. Do not create GitHub issues for ticket delivery.
10. The GitHub pull request body must include a machine-readable line exactly in the form `Linear Issue: {{ issue.identifier }}`.
11. If Linear access is available, use `linear_graphql` only when the task needs tracker context or other Linear operations that are not covered by a dedicated tool.
12. Linear lookup rules:

- The current Linear ticket id is already provided in this prompt as `Ticket ID`. Reuse that provided id for tracker operations that need the current ticket UUID.
- Do not use `linear_graphql` just to look up the current ticket id when the provided `Ticket ID` is already sufficient.
- To fetch a Linear ticket by ticket identifier such as `OWN-15`, use the documented issue lookup form:
  `query IssueByIdentifier($id: String!) { issue(id: $id) { id identifier title } }`
- Example identifier lookup: `issue(id: "OWN-15")`
- Pass the ticket identifier such as `OWN-15` as the query variable `id`.
- Use the returned ticket `id` for follow-up operations that need the current Linear issue UUID.
- Do not use `issueV2(...)`.
- Do not use `issue(identifier: ...)`.

13. When the implementation work is complete and validation passes, call `complete_ticket_delivery` exactly once with a concise summary of what changed and the targeted validation checks you ran beyond `./scripts/verify`.
14. Do not call `linear_add_issue_comment` directly for normal ticket completion.
15. `complete_ticket_delivery` is the required completion path because it runs `./scripts/verify` before publishing, commits the workspace changes when needed, pushes the ticket branch, creates or updates the GitHub pull request, and posts the final Linear completion comment with the PR URL.
16. If `complete_ticket_delivery` fails, stop and report the exact error instead of improvising with manual GitHub or Linear commands.
17. Call `complete_ticket_delivery` before your final output.
18. Final output must summarize completed work, validation run, and any remaining blocker.

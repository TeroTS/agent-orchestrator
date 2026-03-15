# Symphony

Symphony is a TypeScript implementation of the orchestration service described in
[SPEC.md](./SPEC.md). It polls Linear for active work, creates isolated
workspaces, starts Codex app-server sessions, and tracks runtime state in a
single in-memory orchestrator.

## Current implementation

- `WORKFLOW.md` loading, validation, and live reload
- Linear-compatible tracker client
- Per-issue workspace management with lifecycle hooks
- Codex app-server subprocess client over JSON lines
- Polling orchestrator with retries, reconciliation, and stall detection
- Structured logging
- High-signal `agent activity` logs for live Codex progress
- Optional local status server with JSON and HTML surfaces
- Unit and integration-style test coverage with Vitest

Known limitation:

- Token and rate-limit aggregation from Codex events is not implemented yet, so
  the status API currently returns `codex_totals: null` and `rate_limits: null`.

## Requirements

- Node.js 24 LTS recommended
- `npm`
- `codex` CLI available in `PATH` for real runs
- Linear API access via `LINEAR_API_KEY`

## Quick start

Install dependencies:

```bash
./scripts/setup
```

Edit the repository-owned [`WORKFLOW.md`](./WORKFLOW.md):

- set `tracker.project_slug` to your Linear project slug
- adjust `workspace.root` if you do not want local workspaces under
  `./.symphony/workspaces`
- adjust `codex.command` if your Codex launch command differs from
  `codex app-server`

Set required environment variables:

```bash
export LINEAR_API_KEY=your-linear-api-key
```

Optional for tracker and Codex-side Linear request debugging:

```bash
export SYMPHONY_LOG_LEVEL=debug
```

Build and run:

```bash
./scripts/verify
npm start
```

By default the CLI loads `./WORKFLOW.md`.

## CLI

Start with the default workflow in the current directory:

```bash
npm start
```

Start with an explicit workflow path:

```bash
node dist/src/app/main.js /absolute/path/to/WORKFLOW.md
```

Start with the status server enabled on a specific port:

```bash
node dist/src/app/main.js --port 4000
```

You can also combine both:

```bash
node dist/src/app/main.js --port 4000 /absolute/path/to/WORKFLOW.md
```

The host process handles `SIGINT` and `SIGTERM` and attempts a clean shutdown.

## WORKFLOW.md

The service requires a repository-owned [`WORKFLOW.md`](./WORKFLOW.md). It
contains:

- YAML front matter for tracker, polling, workspace, hook, agent, and Codex
  settings
- the prompt template rendered for each issue

The shipped default file is intentionally generic and safe:

- Linear auth comes from `LINEAR_API_KEY`
- workspaces go under `./.symphony/workspaces`
- no Elixir- or repo-specific bootstrap hooks are included

The prompt template supports strict Liquid rendering with `issue` and `attempt`
variables. The shipped workflow exposes the current Linear `issue.id` directly
in the prompt as `Issue ID` so Codex can call `linear_add_issue_comment`
without first looking the issue up via `linear_graphql`. The shipped workflow
also treats branch + PR as the normal delivery path: the agent is expected to
work on an issue branch, open or update a GitHub PR, and include that PR URL in
the final Linear completion comment before the run can hand off successfully.
The shipped PR template is intentionally minimal and machine-filled with
`Linear Issue`, `Context`, and `Summary` sections only. On `Rework` runs, the
default workflow now injects the latest blocking GitHub review feedback into
the agent prompt directly, while Linear receives only a short review-status
breadcrumb instead of a full copy of review findings.

## Status server

The status server is optional. It starts when:

- `--port <n>` is passed on the CLI, or
- `server.port` is present in `WORKFLOW.md`

It binds to `127.0.0.1` and currently exposes:

- `GET /`
- `GET /api/v1/health`
- `GET /api/v1/ready`
- `GET /api/v1/state`
- `GET /api/v1/issues`
- `GET /api/v1/issues/:identifier`
- `GET /api/v1/running`
- `GET /api/v1/retries`
- `GET /api/v1/completed`
- `POST /api/v1/refresh`
- `POST /api/v1/reconcile`

Unsupported methods on known routes return `405 Method Not Allowed`.

## Logs

During active runs, Symphony emits structured `agent activity` log entries for
high-signal Codex milestones such as turn start/completion, command execution,
tool calls, retries, and final agent messages. Low-value streaming deltas and
token-count chatter are intentionally suppressed from this operator-facing log
stream.

When you need full Linear request diagnostics, start the service with
`SYMPHONY_LOG_LEVEL=debug`. In debug mode the real Linear tracker client and the
Codex `linear_graphql` tool log GraphQL query text, variables, status,
duration, and bounded response previews. Authorization values are not logged.

## Testing

Run lint:

```bash
npm run lint
```

Run formatting checks:

```bash
npm run format:check
```

Apply formatting:

```bash
npm run format
```

Run the full test suite:

```bash
npm test
```

Run the test suite with coverage reporting:

```bash
npm run test:coverage
```

Coverage reports are written under `coverage/`.

Run the build:

```bash
npm run build
```

Run the opt-in real integration smoke profile:

```bash
SYMPHONY_REAL_INTEGRATION=1 npm run test:integration
```

Real integration smoke tests additionally require:

- `LINEAR_API_KEY`
- `SYMPHONY_LINEAR_PROJECT_SLUG`
- `codex` in `PATH`

Optionally:

- `SYMPHONY_CODEX_COMMAND`

## Repository layout

- [`src/`](./src) contains the runtime implementation
- [`test/`](./test) contains Vitest coverage
- [`docs/`](./docs) contains architecture, running, operations, and D2 diagrams
- [`WORKFLOW.md`](./WORKFLOW.md) is the default runtime workflow
- [`SPEC.md`](./SPEC.md) is the implementation contract

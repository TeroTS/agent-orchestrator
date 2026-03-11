# Operations

## Startup Dependencies

The service needs, in order:

1. repository workflow configuration
2. tracker credentials and reachable tracker API
3. local filesystem access for workspaces
4. a working `codex` executable for worker sessions

## Configuration Surfaces

- Repository workflow: [`WORKFLOW.md`](../WORKFLOW.md)
- Runtime pinning: [`.nvmrc`](../.nvmrc)
- Golden path commands: [`scripts/setup`](../scripts/setup),
  [`scripts/verify`](../scripts/verify)

Use environment indirection for secrets such as `LINEAR_API_KEY`.

## Logging and Monitoring

- Structured logs are emitted to stdout/stderr from the service process.
- The optional HTTP surface provides `/`, `/api/v1/state`, `/api/v1/issues`,
  `/api/v1/running`, `/api/v1/retries`, `/api/v1/completed`, `/api/v1/health`,
  `/api/v1/ready`, `/api/v1/refresh`, and `/api/v1/reconcile`.

## Failure Modes

- **Workflow validation failure**: startup or dispatch is blocked until config is
  valid.
- **Tracker fetch failure**: the tick is skipped and retried on the next poll.
- **Worker spawn or turn failure**: the issue is retried with backoff.
- **Stalled worker session**: the orchestrator treats it as stalled and stops
  the run based on configured timeouts.
- **Terminal issue state**: the workspace is cleaned up and the issue leaves the
  active set.

## What to Check First

1. Is `WORKFLOW.md` valid and pointing at the expected project?
2. Does `./scripts/verify` pass locally?
3. Are tracker credentials present and accepted?
4. Is `codex` installed and runnable from the repo shell?
5. Does `/api/v1/state` show the expected running or retrying issue?

## Known Limitation

Token and rate-limit aggregation are not yet implemented, so `codex_totals` and
`rate_limits` remain `null` in the status API.

# Running

## Prerequisites

- Node.js version from [`.nvmrc`](../.nvmrc)
- `npm`
- `codex` available in `PATH` for real runs
- `LINEAR_API_KEY` for tracker access

## Local Setup

Install dependencies:

```bash
./scripts/setup
```

## Start the Service

Use the repository-owned workflow:

```bash
./scripts/verify
npm start
```

Enable debug-level Linear request logging when investigating tracker or
`linear_graphql` failures:

```bash
SYMPHONY_LOG_LEVEL=debug npm start
```

Run with an explicit workflow file:

```bash
node dist/src/app/main.js /absolute/path/to/WORKFLOW.md
```

Enable the status server:

```bash
node dist/src/app/main.js --port 4000
```

## Test and Validation

```bash
./scripts/verify
```

Other useful commands:

```bash
npm run test:coverage
npm test -- test/orchestrator/orchestrator.test.ts
```

## First-Run Troubleshooting

- If startup fails immediately, check that `WORKFLOW.md` exists and validates.
- If tracker calls fail, verify `LINEAR_API_KEY` and `tracker.project_slug`.
- If Linear requests need deeper inspection, rerun with
  `SYMPHONY_LOG_LEVEL=debug` to log query text, variables, HTTP status, and a
  bounded response preview.
- If worker startup fails, verify `codex` is installed and callable from `PATH`.
- If the status server does not start, check for port conflicts or invalid
  `server.port` overrides.

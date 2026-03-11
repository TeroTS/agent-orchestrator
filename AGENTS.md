# Repository Guidelines

## Project

This repository is a TypeScript implementation of Symphony. It polls Linear,
creates isolated workspaces, starts Codex app-server sessions, and tracks all
runtime state in a single in-memory orchestrator.

## Repo Layout

- `src/app/`: CLI, host lifecycle, service composition
- `src/codex/`: Codex app-server protocol client and runner
- `src/orchestrator/`: dispatch rules, state, reconciliation
- `src/workflow/`: `WORKFLOW.md` parsing and reload logic
- `src/observability/`: status server and structured logging
- `src/tracker/`: Linear client
- `src/workspace/`: workspace safety and lifecycle hooks
- `test/`: Vitest suites, including `repository-*.test.ts` guardrails
- `dist/`: compiled output

## Golden Path

```bash
./scripts/setup
./scripts/verify
```

## Common Commands

- Install: `./scripts/setup`
- Verify: `./scripts/verify`
- Build: `npm run build`
- Lint: `npm run lint`
- Format check: `npm run format:check`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Coverage: `npm run test:coverage`
- Start service: `npm start`

## Run a Single Test

- One file: `npm test -- test/orchestrator.test.ts`
- One named case: `npx vitest run test/orchestrator.test.ts -t "tracks live session metadata"`

## Rules

- Add new runtime code under the matching feature directory in `src/`.
- Add tests in `test/` using `*.test.ts`.
- Keep repo-level workflows deterministic and non-interactive.
- If you add shipped scripts, config, or layout rules, update the
  `test/repository-*.test.ts` guard tests.
- Generated output in `dist/` and `coverage/` must not be edited by hand.

## Gotchas

- `WORKFLOW.md` is required for real runs.
- Use env indirection for secrets such as `LINEAR_API_KEY`; never commit secrets.
- `test:integration` is opt-in and requires real external credentials and a
  working `codex` binary.

# Architecture

## Overview

Symphony is a single-process orchestration service that turns active tracker
items into isolated coding-agent runs. It polls the tracker for active issues,
creates per-issue workspaces, starts a Codex app-server session for each
dispatch, and keeps runtime state in one in-memory orchestrator.

Primary users are contributors and operators who need to run the service
locally, observe active work, and change workflow behavior through
repository-owned configuration.

## Component Map

- **Workflow loader/store**: reads `WORKFLOW.md`, validates dispatch-critical
  config, and reloads changes.
- **Tracker client**: fetches candidate, active, and terminal issues from the
  tracker boundary.
- **Orchestrator**: owns mutable runtime state, scheduling, retries, and
  reconciliation.
- **Workspace manager**: creates, prepares, finalizes, and removes per-issue
  workspaces safely.
- **Codex runner/client**: starts the coding-agent subprocess and converts
  protocol events into orchestration updates.
- **Observability surface**: structured logs plus optional HTTP status endpoints.

See [system context](./diagrams/system_context.d2) and
[deployment topology](./diagrams/deployment_topology.d2).

## Runtime Flows

1. **Issue dispatch flow**:
   workflow config is loaded, tracker issues are polled, eligible items are
   dispatched into workspaces, and Codex sessions run until completion or retry.
   See [key flow: issue dispatch](./diagrams/key_flow_issue_dispatch.d2).

2. **Runtime observability flow**:
   worker events and orchestrator state are exposed through logs and the status
   server. See [key flow: observability](./diagrams/key_flow_observability.d2).

## System Boundaries

- **Repository workflow contract**: `WORKFLOW.md`
- **Tracker boundary**: Linear-compatible GraphQL issue reads
- **Coding-agent boundary**: Codex app-server JSON-over-stdio protocol
- **Operator boundary**: `GET /`, `GET /api/v1/*`, `POST /api/v1/refresh`,
  `POST /api/v1/reconcile`

Boundary models are documented in [data models](./data-models.md).

## Operational Topology

Locally and in production, the system is a single runtime process with optional
HTTP observability enabled. External dependencies are the tracker API, a working
`codex` command, the local filesystem for workspaces, and repository-owned
workflow configuration.

See [running](./running.md) and [operations](./operations.md).

## How to Change Safely

- Update `WORKFLOW.md` handling whenever config or prompt contract changes.
- Update tracker and status docs when boundary payloads change.
- Keep `test/repository-*.test.ts` guardrails current when scripts, layout, or
  shipped config changes.
- Update the D2 diagrams when a component boundary, runtime flow, or deployment
  assumption changes.

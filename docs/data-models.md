# Data Models

This document covers boundary models only: data that crosses process, file, or
module boundaries.

## Workflow Definition

- **Purpose**: repository-owned runtime contract loaded from `WORKFLOW.md`
- **Fields**:
  - `config` (object, required): tracker, polling, workspace, hook, agent, and
    Codex settings
  - `promptTemplate` (string, required): strict Liquid template rendered per
    issue
- **Producers / Consumers**:
  - produced by the repository file
  - consumed by workflow store, orchestrator, runner, and service startup
- **Compatibility**:
  - missing required dispatch fields fail validation
  - additive config fields are acceptable when ignored safely
- **Source**: [`WORKFLOW.md`](../WORKFLOW.md)

## Effective Workflow Config

- **Purpose**: validated runtime config derived from the workflow file
- **Fields**:
  - `tracker`: endpoint, API key, project slug, active and terminal states
  - `polling`: interval
  - `workspace`: root path
  - `hooks`: optional scripts and timeout
  - `agent`: concurrency, turn, and retry settings
  - `codex`: command and timeout/sandbox settings
- **Producers / Consumers**:
  - produced by workflow validation
  - consumed by the orchestrator, service, tracker client, and runner
- **Compatibility**:
  - defaults are applied during validation
  - invalid dispatch-critical fields block startup or dispatch
- **Source**: [`src/workflow/loader.ts`](../src/workflow/loader.ts)

## Tracker Issue

- **Purpose**: normalized tracker record used for dispatch and reconciliation
- **Fields**:
  - `id`, `identifier`, `title`, `state` (required)
  - `description?`, `priority?`, `branchName?`, `url?`
  - `labels[]`
  - `blockedBy[]` with `id?`, `identifier?`, `state?`
  - `createdAt?`, `updatedAt?`
- **Producers / Consumers**:
  - produced by the tracker client
  - consumed by the orchestrator and prompt rendering
- **Compatibility**:
  - normalization tolerates partial upstream payloads
  - missing required logical fields should fail as malformed tracker data
- **Source**: [`src/tracker/linear-client.ts`](../src/tracker/linear-client.ts)

## Codex Runtime Event

- **Purpose**: upstream event stream from the coding-agent session into the
  orchestrator
- **Fields**:
  - `event` and `timestamp` (required)
  - `sessionId?`, `codexAppServerPid?`, `message?`, `usage?`, `payload?`
- **Producers / Consumers**:
  - produced by the Codex app-server client
  - consumed by the orchestrator to update live run state
- **Compatibility**:
  - event payloads are handled leniently
  - token/rate-limit aggregation is not yet implemented
- **Source**: [`src/codex/app-server.ts`](../src/codex/app-server.ts)

## Runtime Snapshot / Status API

- **Purpose**: operator-facing view of running, retrying, and completed work
- **Fields**:
  - `running[]`: issue/session state, timestamps, last event, turn count
  - `retrying[]`: attempt, due time, last error
  - `completed_issue_ids[]`
  - `codex_totals`, `rate_limits` currently returned as `null`
- **Producers / Consumers**:
  - produced by the orchestrator snapshot
  - consumed by the HTTP status surface and operators
- **Compatibility**:
  - exposed under `/api/v1/*`; additive changes should preserve existing fields
- **Source**: [`src/observability/status-server.ts`](../src/observability/status-server.ts)

Model diagram: [runtime models](./diagrams/models/runtime_models.d2)

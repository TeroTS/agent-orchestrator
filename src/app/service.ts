import { rm } from "node:fs/promises";
import { watch } from "node:fs";

import { AgentRunner } from "../codex/agent-runner.js";
import {
  SymphonyOrchestrator,
  type WorkflowStoreLike,
} from "../orchestrator/orchestrator.js";
import {
  startStatusServer,
  type StatusServerHandle,
} from "../observability/status-server.js";
import {
  createStructuredLogger,
  resolveStructuredLogLevel,
  type StructuredLogger,
} from "../observability/structured-logger.js";
import { LinearTrackerClient } from "../tracker/linear-client.js";
import {
  validateWorkflowForDispatch,
  type EffectiveWorkflowConfig,
  type WorkflowDefinition,
} from "../workflow/loader.js";
import { WorkflowStore } from "../workflow/store.js";

export interface SymphonyService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type TrackerFacade = {
  fetchCandidateIssues(activeStates: string[]): Promise<any[]>;
  fetchIssuesByStates(states: string[]): Promise<any[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<any[]>;
  fetchIssueContextById(issueId: string): Promise<any>;
  transitionIssueToState(issueId: string, stateName: string): Promise<any>;
};

type RunnerFacade = {
  startRun(input: {
    issue: any;
    attempt: number | null;
    onEvent?: (event: any) => void;
  }): { cancel(): void; promise: Promise<any> };
};

export async function createService(input: {
  workflowPath: string;
  port?: number;
  workflowStore?: WorkflowStoreLike;
  tracker?: TrackerFacade;
  runner?: RunnerFacade;
  watchFactory?: (
    path: string,
    listener: () => void | Promise<void>,
  ) => { close(): void };
  startStatusServerFn?: typeof startStatusServer;
  logger?: StructuredLogger;
}): Promise<SymphonyService> {
  const logger =
    input.logger ??
    createStructuredLogger({
      level: resolveStructuredLogLevel(process.env.SYMPHONY_LOG_LEVEL),
    });
  const workflowStore =
    input.workflowStore ??
    new WorkflowStore({
      workflowPath: input.workflowPath,
    });

  let statusServer: StatusServerHandle | null = null;
  let boundStatusPort: number | undefined;
  let watcher: { close(): void } | null = null;

  const trackerFacade: TrackerFacade = input.tracker ?? {
    fetchCandidateIssues: async (activeStates: string[]) => {
      const client = createTrackerClient(workflowStore.current(), logger);
      return client.fetchCandidateIssues(activeStates);
    },
    fetchIssuesByStates: async (states: string[]) => {
      const client = createTrackerClient(workflowStore.current(), logger);
      return client.fetchIssuesByStates(states);
    },
    fetchIssueStatesByIds: async (issueIds: string[]) => {
      const client = createTrackerClient(workflowStore.current(), logger);
      return client.fetchIssueStatesByIds(issueIds);
    },
    fetchIssueContextById: async (issueId: string) => {
      const client = createTrackerClient(workflowStore.current(), logger);
      return client.fetchIssueContextById(issueId);
    },
    transitionIssueToState: async (issueId: string, stateName: string) => {
      const client = createTrackerClient(workflowStore.current(), logger);
      return client.transitionIssueToState(issueId, stateName);
    },
  };

  const runnerFacade: RunnerFacade = input.runner ?? {
    startRun: ({ issue, attempt, onEvent }) => {
      const controller = new AbortController();
      const runner = new AgentRunner({
        workflowDefinition: workflowStore.current(),
        issueStateRefresher: trackerFacade.fetchIssueStatesByIds,
        issueContextFetcher: trackerFacade.fetchIssueContextById,
        logger,
      });

      return {
        cancel: () => controller.abort(),
        promise: runner
          .runAttempt({
            issue,
            attempt,
            signal: controller.signal,
            ...(onEvent ? { onEvent } : {}),
          })
          .catch(async (error) => {
            logger.error("worker attempt failed", {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }),
      };
    },
  };

  const orchestrator = new SymphonyOrchestrator({
    workflowStore,
    tracker: trackerFacade,
    runner: runnerFacade,
    removeWorkspace: async (workspacePath) => {
      await rm(workspacePath, { recursive: true, force: true });
    },
    logger,
  });

  return {
    async start() {
      await orchestrator.start();
      logger.info("service started", {
        workflow_path: input.workflowPath,
      });
      boundStatusPort =
        input.port ?? extractServerPort(workflowStore.current());
      statusServer = await bindStatusServer(
        statusServer,
        input.startStatusServerFn ?? startStatusServer,
        boundStatusPort,
        orchestrator,
        logger,
      );

      const watchFactory =
        input.watchFactory ?? ((path, listener) => watch(path, listener));
      watcher = watchFactory(input.workflowPath, async () => {
        const reload = await workflowStore.reload();
        if (!reload.ok) {
          logger.warn("workflow reload failed", {
            workflow_path: input.workflowPath,
          });
          return;
        }

        const nextPort =
          input.port ?? extractServerPort(workflowStore.current());
        if (boundStatusPort !== nextPort) {
          logger.info("status server rebind", {
            from_port: boundStatusPort ?? "disabled",
            to_port: nextPort ?? "disabled",
          });
          statusServer = await bindStatusServer(
            statusServer,
            input.startStatusServerFn ?? startStatusServer,
            nextPort,
            orchestrator,
            logger,
          );
          boundStatusPort = nextPort;
        }
      });
    },
    async stop() {
      watcher?.close();
      watcher = null;

      if (statusServer) {
        await statusServer.stop();
        statusServer = null;
      }

      await orchestrator.stop();
      logger.info("service stopped", {
        workflow_path: input.workflowPath,
      });
    },
  };
}

function createTrackerClient(
  definition: WorkflowDefinition,
  logger: StructuredLogger,
): LinearTrackerClient {
  const config = requireValidConfig(definition);
  return new LinearTrackerClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug,
    logger,
  });
}

function requireValidConfig(
  definition: WorkflowDefinition,
): EffectiveWorkflowConfig {
  const validation = validateWorkflowForDispatch(definition);
  if (!validation.ok) {
    throw new Error(validation.errors.join(", "));
  }
  return validation.config;
}

function extractServerPort(definition: WorkflowDefinition): number | undefined {
  const server = definition.config.server;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return undefined;
  }

  const port = (server as Record<string, unknown>).port;
  if (typeof port === "number" && Number.isInteger(port) && port >= 0) {
    return port;
  }

  if (typeof port === "string" && /^\d+$/.test(port)) {
    return Number.parseInt(port, 10);
  }

  return undefined;
}

async function bindStatusServer(
  currentServer: StatusServerHandle | null,
  startStatusServerFn: typeof startStatusServer,
  port: number | undefined,
  orchestrator: SymphonyOrchestrator,
  logger: StructuredLogger,
): Promise<StatusServerHandle | null> {
  if (currentServer) {
    await currentServer.stop();
  }

  if (typeof port !== "number") {
    return null;
  }

  return startStatusServerFn({
    port,
    snapshot: () => orchestrator.snapshot(),
    refresh: async () => {
      await orchestrator.tick();
      return orchestrator.snapshot();
    },
    logger,
  });
}

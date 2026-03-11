import { rm } from "node:fs/promises";
import { watch } from "node:fs";

import { AgentRunner } from "./agent-runner.js";
import { SymphonyOrchestrator } from "./orchestrator.js";
import { startStatusServer, type StatusServerHandle } from "./status-server.js";
import { LinearTrackerClient } from "./tracker/linear-client.js";
import {
  validateWorkflowForDispatch,
  type EffectiveWorkflowConfig,
  type WorkflowDefinition
} from "./workflow-loader.js";
import { WorkflowStore } from "./workflow-store.js";
import { workspacePathFor } from "./workspace-manager.js";

export interface SymphonyService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createService(input: {
  workflowPath: string;
  port?: number;
}): Promise<SymphonyService> {
  const workflowStore = new WorkflowStore({
    workflowPath: input.workflowPath
  });

  let statusServer: StatusServerHandle | null = null;
  let watcher: ReturnType<typeof watch> | null = null;

  const trackerFacade = {
    fetchCandidateIssues: async (activeStates: string[]) => {
      const client = createTrackerClient(workflowStore.current());
      return client.fetchCandidateIssues(activeStates);
    },
    fetchIssuesByStates: async (states: string[]) => {
      const client = createTrackerClient(workflowStore.current());
      return client.fetchIssuesByStates(states);
    },
    fetchIssueStatesByIds: async (issueIds: string[]) => {
      const client = createTrackerClient(workflowStore.current());
      return client.fetchIssueStatesByIds(issueIds);
    }
  };

  const orchestrator = new SymphonyOrchestrator({
    workflowStore,
    tracker: trackerFacade,
    runner: {
      startRun: ({ issue, attempt }) => {
        const controller = new AbortController();
        const runner = new AgentRunner({
          workflowDefinition: workflowStore.current(),
          issueStateRefresher: trackerFacade.fetchIssueStatesByIds
        });

        return {
          cancel: () => controller.abort(),
          promise: runner.runAttempt({
            issue,
            attempt,
            signal: controller.signal
          })
        };
      }
    },
    removeWorkspace: async (workspacePath) => {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  return {
    async start() {
      await orchestrator.start();

      const port = input.port ?? extractServerPort(workflowStore.current());
      if (typeof port === "number") {
        statusServer = await startStatusServer({
          port,
          snapshot: () => orchestrator.snapshot()
        });
      }

      watcher = watch(input.workflowPath, () => {
        void workflowStore.reload();
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
    }
  };
}

function createTrackerClient(definition: WorkflowDefinition): LinearTrackerClient {
  const config = requireValidConfig(definition);
  return new LinearTrackerClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug
  });
}

function requireValidConfig(definition: WorkflowDefinition): EffectiveWorkflowConfig {
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

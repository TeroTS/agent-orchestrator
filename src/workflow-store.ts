import {
  loadWorkflowDefinition,
  type WorkflowDefinition,
} from "./workflow-loader.js";

export interface WorkflowStoreOptions {
  workflowPath: string;
}

export type WorkflowStoreLoadResult =
  | { ok: true; current: WorkflowDefinition }
  | { ok: false; error: unknown; current: WorkflowDefinition | null };

export class WorkflowStore {
  private readonly workflowPath: string;
  private currentDefinition: WorkflowDefinition | null = null;

  constructor(options: WorkflowStoreOptions) {
    this.workflowPath = options.workflowPath;
  }

  async load(): Promise<{ current: WorkflowDefinition }> {
    const definition = await loadWorkflowDefinition({
      workflowPath: this.workflowPath,
    });
    this.currentDefinition = definition;
    return { current: definition };
  }

  async reload(): Promise<WorkflowStoreLoadResult> {
    try {
      const definition = await loadWorkflowDefinition({
        workflowPath: this.workflowPath,
      });
      this.currentDefinition = definition;
      return { ok: true, current: definition };
    } catch (error) {
      return {
        ok: false,
        error,
        current: this.currentDefinition,
      };
    }
  }

  current(): WorkflowDefinition {
    if (!this.currentDefinition) {
      throw new Error("WorkflowStore has not been loaded yet.");
    }

    return this.currentDefinition;
  }
}

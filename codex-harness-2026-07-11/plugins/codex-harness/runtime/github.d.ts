import { type HarnessTask, type RunState } from "./domain.js";
import { RunStore } from "./store.js";
export declare function syncTaskIssues(store: RunStore, runId: string, repoRoot: string): Promise<RunState>;
export declare function renderTaskIssueBody(state: RunState, task: HarnessTask, isPrivate: boolean): string;
export declare function markerFor(runId: string, taskId: string): string;

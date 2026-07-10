import { type RunState } from "./domain.js";
import { RunStore } from "./store.js";
export declare function prepareTaskWorktree(store: RunStore, runId: string, taskId: string): Promise<RunState>;
export declare function commitTask(store: RunStore, runId: string, taskId: string, message: string): Promise<RunState>;
export declare function discardTaskWorktree(store: RunStore, runId: string, taskId: string): Promise<RunState>;

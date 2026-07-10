import type { Lane, RunState } from "./domain.js";
import { type BuilderOutput, type ReviewOutput } from "./codex-worker.js";
import { RunStore } from "./store.js";
export declare function routeLane(goal: string): Lane;
export declare function planRun(store: RunStore, state: RunState): Promise<RunState>;
export declare function buildTask(store: RunStore, runId: string, taskId: string): Promise<{
    state: RunState;
    output: BuilderOutput;
}>;
export declare function reviewTask(store: RunStore, runId: string, taskId: string): Promise<{
    acceptance: ReviewOutput;
    adversarial: ReviewOutput;
    treeHash: string;
}>;

import type { RunState } from "./domain.js";
import { RunStore } from "./store.js";
export declare function runAutonomously(store: RunStore, runId: string): Promise<RunState>;
